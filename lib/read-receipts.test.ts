import { describe, expect, test } from "bun:test";
import {
  autoReadKey,
  loggedSender,
  manualReadKey,
  readReceiptsEnabled,
  type DeliveredMessage,
} from "./read-receipts";

const DM = "15550001111@s.whatsapp.net";
const GROUP = "120363000000000001@g.us";
const SENDER = "15550002222@s.whatsapp.net";

const dmKey = { remoteJid: DM, id: "DM1", fromMe: false };
const groupKey = {
  remoteJid: GROUP,
  id: "G1",
  fromMe: false,
  participant: SENDER,
};

function delivered(over: Partial<DeliveredMessage> = {}): DeliveredMessage {
  return {
    enabled: true,
    provider: "baileys",
    gate: "deliver",
    backlog: false,
    key: dmKey,
    ...over,
  };
}

describe("readReceiptsEnabled", () => {
  test("only 1 turns it on", () => {
    expect(readReceiptsEnabled("1")).toBe(true);
    expect(readReceiptsEnabled(" 1 ")).toBe(true);
  });

  test("unset, blank, 0 or anything else leaves it off", () => {
    for (const raw of [undefined, "", "0", "true", "yes", "on"])
      expect(readReceiptsEnabled(raw)).toBe(false);
  });
});

describe("autoReadKey", () => {
  test("a DM delivered to the agent is marked read, without a participant", () => {
    expect(
      autoReadKey(delivered({ key: { ...dmKey, participant: SENDER } })),
    ).toEqual({ remoteJid: DM, id: "DM1", fromMe: false });
  });

  test("a group message keeps its sender as the participant", () => {
    expect(autoReadKey(delivered({ key: groupKey }))).toEqual(groupKey);
  });

  test("nothing is marked while the setting is off", () => {
    expect(autoReadKey(delivered({ enabled: false }))).toBeUndefined();
  });

  test("a chat the gate dropped or held for pairing is never marked", () => {
    expect(autoReadKey(delivered({ gate: "drop" }))).toBeUndefined();
    expect(autoReadKey(delivered({ gate: "pair" }))).toBeUndefined();
    expect(
      autoReadKey(delivered({ gate: "drop", key: groupKey })),
    ).toBeUndefined();
  });

  test("backlog the agent was not shown is not marked", () => {
    expect(autoReadKey(delivered({ backlog: true }))).toBeUndefined();
  });

  test("Cloud API sends no receipt", () => {
    expect(autoReadKey(delivered({ provider: "cloud-api" }))).toBeUndefined();
  });

  test("a group message without its participant is skipped, not sent to the group", () => {
    const { participant: _, ...noParticipant } = groupKey;
    expect(autoReadKey(delivered({ key: noParticipant }))).toBeUndefined();
  });

  test("own messages, status updates, channels and id-less keys are skipped", () => {
    for (const key of [
      { ...dmKey, fromMe: true },
      { remoteJid: "status@broadcast", id: "S1", participant: SENDER },
      { remoteJid: "1234@newsletter", id: "N1" },
      { remoteJid: DM, id: "" },
      { id: "X1" },
    ])
      expect(autoReadKey(delivered({ key }))).toBeUndefined();
  });
});

describe("loggedSender", () => {
  const line = (entry: Record<string, unknown>) => JSON.stringify(entry);
  const log = [
    line({ id: "G1", chat_id: GROUP, user: "A", user_id: SENDER }),
    line({ id: "O1", chat_id: GROUP, user_id: "me", direction: "out" }),
    line({ id: "D1", chat_id: DM, user_id: DM, direction: "in" }),
    "not json",
    "",
  ].join("\n");

  test("finds the sender of an inbound line in that chat", () => {
    expect(loggedSender(log, GROUP, "G1")).toBe(SENDER);
    expect(loggedSender(log, DM, "D1")).toBe(DM);
  });

  test("ignores outbound lines, other chats and unknown ids", () => {
    expect(loggedSender(log, GROUP, "O1")).toBeUndefined();
    expect(loggedSender(log, DM, "G1")).toBeUndefined();
    expect(loggedSender(log, GROUP, "missing")).toBeUndefined();
    expect(loggedSender(log, GROUP, "")).toBeUndefined();
  });

  test("message text quoting an id cannot pose as that line", () => {
    const spoof = line({
      id: "T1",
      chat_id: GROUP,
      user_id: "evil@s.whatsapp.net",
      text: '{"id":"G2","chat_id":"x"}',
    });
    expect(loggedSender(spoof, GROUP, "G2")).toBeUndefined();
  });
});

describe("manualReadKey", () => {
  test("uses the stored key for a recent message", () => {
    expect(manualReadKey(GROUP, "G1", groupKey)).toEqual(groupKey);
  });

  test("builds a DM key when the store has forgotten the message", () => {
    expect(manualReadKey(DM, "DM9")).toEqual({
      remoteJid: DM,
      id: "DM9",
      fromMe: false,
    });
  });

  test("a forgotten group message takes its sender from the log", () => {
    expect(manualReadKey(GROUP, "G9", undefined, SENDER)).toEqual({
      remoteJid: GROUP,
      id: "G9",
      fromMe: false,
      participant: SENDER,
    });
  });

  test("a group message with no known sender fails clearly", () => {
    expect(() => manualReadKey(GROUP, "G9")).toThrow(/needs the sender/);
  });

  test("a stored message from another chat is refused", () => {
    expect(() => manualReadKey(DM, "G1", groupKey)).toThrow(/not in chat/);
  });

  test("the chat may be named by the stored key's alternate jid", () => {
    const lidKey = {
      remoteJid: "999@lid",
      remoteJidAlt: DM,
      id: "L1",
      fromMe: false,
    };
    expect(manualReadKey(DM, "L1", lidKey)).toEqual({
      remoteJid: "999@lid",
      id: "L1",
      fromMe: false,
    });
  });

  test("the account's own message is refused", () => {
    expect(() => manualReadKey(DM, "M1", { ...dmKey, fromMe: true })).toThrow(
      /sent by this account/,
    );
  });

  test("an outbound DM id the store never kept is refused, not synthesized", () => {
    expect(() => manualReadKey(DM, "OUT1", undefined, undefined, true)).toThrow(
      /sent by this account/,
    );
  });

  test("a sent group id is refused even with a sender on record", () => {
    expect(() => manualReadKey(GROUP, "OUT2", undefined, SENDER, true)).toThrow(
      /sent by this account/,
    );
  });

  test("a DM id this server did not send still gets its key", () => {
    expect(manualReadKey(DM, "DM9", undefined, undefined, false)).toEqual({
      remoteJid: DM,
      id: "DM9",
      fromMe: false,
    });
  });

  test("missing ids and receipt-less chats are refused", () => {
    expect(() => manualReadKey(DM, "")).toThrow(/needs chat_id/);
    expect(() => manualReadKey("1234@newsletter", "N1")).toThrow(
      /does not take read receipts/,
    );
  });
});
