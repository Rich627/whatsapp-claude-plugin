import { describe, expect, mock, test } from "bun:test";
import { EventEmitter } from "node:events";
import { deflateSync } from "node:zlib";
import { initAuthCreds, proto, type WAMessage } from "@whiskeysockets/baileys";
import processMessage from "@whiskeysockets/baileys/lib/Utils/process-message.js";

type Context = Parameters<typeof processMessage>[1];
const Type = proto.Message.ProtocolMessage.Type;
const OWNER = "15550000001@s.whatsapp.net";
const OTHER = "15550000002@s.whatsapp.net";
const TIMESTAMP = 1_700_000_000;
const recoveredMessage: WAMessage = {
  key: { remoteJid: OTHER, fromMe: false, id: "recovered-message" },
  messageTimestamp: TIMESTAMP,
  message: { conversation: "Recovered message content" },
};

function protocolMessage(
  protocol: proto.Message.IProtocolMessage,
  fromMe: boolean | undefined,
): WAMessage {
  return {
    key: { remoteJid: OTHER, fromMe, id: "protocol-envelope" },
    messageTimestamp: TIMESTAMP,
    message: { protocolMessage: protocol },
  };
}

function harness() {
  const events: Array<{ event: string; payload: unknown }> = [];
  const ev = new EventEmitter();
  for (const event of [
    "messages.upsert",
    "messages.update",
    "messaging-history.set",
    "creds.update",
    "chats.update",
  ]) {
    ev.on(event, (payload: unknown) => events.push({ event, payload }));
  }
  const set = mock(
    async (_data: Parameters<Context["keyStore"]["set"]>[0]) => {},
  );
  const transactions: string[] = [];
  const storeLIDPNMappings = mock(
    async (_pairs: Array<{ pn: string; lid: string }>) => {},
  );
  const migrateSession = mock(async (_pn: string, _lid: string) => {});
  const cacheGet = mock((_id: string) => undefined);
  const cacheDelete = mock((_id: string) => {});
  const creds = initAuthCreds();
  creds.me = { id: OWNER, name: "Test owner" };
  // Only these repository methods are exercised by protocol processing. This
  // boundary supplies in-memory effects, never a real Signal repository/session.
  const signalRepository = {
    lidMapping: {
      storeLIDPNMappings,
      getLIDForPN: async () => null,
    },
    migrateSession,
  } as unknown as Context["signalRepository"];
  const context: Context = {
    shouldProcessHistoryMsg: true,
    creds,
    ev,
    keyStore: {
      get: async () => ({}),
      set,
      isInTransaction: () => false,
      transaction: async <T>(exec: () => Promise<T>, key: string) => {
        transactions.push(key);
        return exec();
      },
    },
    signalRepository,
    placeholderResendCache: {
      get: cacheGet,
      del: cacheDelete,
      set: () => {},
      flushAll: () => {},
    },
    options: {},
    getMessage: async () => undefined,
  };
  return {
    context,
    events,
    set,
    transactions,
    storeLIDPNMappings,
    migrateSession,
    cacheGet,
    cacheDelete,
  };
}

const historyProtocol: proto.Message.IProtocolMessage = {
  type: Type.HISTORY_SYNC_NOTIFICATION,
  historySyncNotification: {
    syncType: proto.Message.HistorySyncType.INITIAL_BOOTSTRAP,
    // Exercise the real inflater/decoder without contacting WhatsApp.
    initialHistBootstrapInlinePayload: deflateSync(
      proto.HistorySync.encode({
        syncType: proto.HistorySync.HistorySyncType.INITIAL_BOOTSTRAP,
        conversations: [
          { id: OTHER, messages: [{ message: recoveredMessage }] },
        ],
      }).finish(),
    ),
  },
};
const keyData = { keyData: Buffer.alloc(32, 1), timestamp: TIMESTAMP };
const keyShareProtocol: proto.Message.IProtocolMessage = {
  type: Type.APP_STATE_SYNC_KEY_SHARE,
  appStateSyncKeyShare: {
    keys: [{ keyId: { keyId: Buffer.from("test-key-id") }, keyData }],
  },
};
const mappingProtocol: proto.Message.IProtocolMessage = {
  type: Type.LID_MIGRATION_MAPPING_SYNC,
  lidMigrationMappingSyncMessage: {
    encodedMappingPayload: proto.LIDMigrationMappingSyncPayload.encode({
      pnToLidMappings: [{ pn: 15550000002, latestLid: 123456789 }],
    }).finish(),
  },
};
const resendProtocol: proto.Message.IProtocolMessage = {
  type: Type.PEER_DATA_OPERATION_REQUEST_RESPONSE_MESSAGE,
  peerDataOperationRequestResponseMessage: {
    stanzaId: "test-request",
    peerDataOperationResult: [
      {
        placeholderMessageResendResponse: {
          webMessageInfoBytes:
            proto.WebMessageInfo.encode(recoveredMessage).finish(),
        },
      },
    ],
  },
};

describe("Baileys GHSA-qvv5-jq5g-4cgg protocol origin validation", () => {
  for (const [name, protocol] of [
    ["history sync", historyProtocol],
    ["app state key share", keyShareProtocol],
    ["LID migration", mappingProtocol],
    ["placeholder resend", resendProtocol],
  ] as const) {
    for (const fromMe of [false, undefined]) {
      test(`rejects non-self ${name} (fromMe=${String(fromMe)})`, async () => {
        const h = harness();
        await processMessage(protocolMessage(protocol, fromMe), h.context);
        expect(h.events).toEqual([]);
        expect(h.set).not.toHaveBeenCalled();
        expect(h.transactions).toEqual([]);
        expect(h.storeLIDPNMappings).not.toHaveBeenCalled();
        expect(h.migrateSession).not.toHaveBeenCalled();
        expect(h.cacheGet).not.toHaveBeenCalled();
        expect(h.cacheDelete).not.toHaveBeenCalled();
      });
    }
  }

  test("accepts self-owned history sync and recovers its actual inline messages", async () => {
    const h = harness();
    const envelope = protocolMessage(historyProtocol, true);
    await processMessage(envelope, h.context);
    expect(h.events).toEqual([
      {
        event: "creds.update",
        payload: {
          processedHistoryMessages: [
            { key: envelope.key, messageTimestamp: TIMESTAMP },
          ],
        },
      },
      {
        event: "messaging-history.set",
        payload: expect.objectContaining({
          isLatest: true,
          messages: [
            expect.objectContaining({
              key: expect.objectContaining(recoveredMessage.key),
              message: expect.objectContaining(recoveredMessage.message),
            }),
          ],
        }),
      },
    ]);
  });

  test("accepts self-owned app state keys and updates credentials", async () => {
    const h = harness();
    await processMessage(protocolMessage(keyShareProtocol, true), h.context);
    const keyId = Buffer.from("test-key-id").toString("base64");
    expect(h.transactions).toEqual([OWNER]);
    expect(h.set).toHaveBeenCalledWith({
      "app-state-sync-key": { [keyId]: keyData },
    });
    expect(h.events).toEqual([
      { event: "creds.update", payload: { myAppStateKeyId: keyId } },
    ]);
  });

  test("accepts self-owned LID mappings and migrates the associated session", async () => {
    const h = harness();
    await processMessage(protocolMessage(mappingProtocol, true), h.context);
    expect(h.storeLIDPNMappings).toHaveBeenCalledWith([
      { pn: OTHER, lid: "123456789@lid" },
    ]);
    expect(h.migrateSession).toHaveBeenCalledWith(OTHER, "123456789@lid");
  });

  test("accepts self-owned placeholder resends and emits their recovered content", async () => {
    const h = harness();
    await processMessage(protocolMessage(resendProtocol, true), h.context);
    expect(h.cacheGet).toHaveBeenCalledWith("recovered-message");
    expect(h.cacheDelete).toHaveBeenCalledWith("recovered-message");
    expect(h.events).toEqual([
      {
        event: "messages.upsert",
        payload: {
          type: "notify",
          requestId: "test-request",
          messages: [
            expect.objectContaining({
              key: expect.objectContaining(recoveredMessage.key),
              message: expect.objectContaining(recoveredMessage.message),
            }),
          ],
        },
      },
    ]);
  });

  test("preserves another user's legitimate message edit", async () => {
    const h = harness();
    await processMessage(
      protocolMessage(
        {
          type: Type.MESSAGE_EDIT,
          key: { id: "edited-message" },
          editedMessage: { conversation: "Edited text" },
          timestampMs: TIMESTAMP * 1000,
        },
        false,
      ),
      h.context,
    );
    expect(h.events).toEqual([
      {
        event: "messages.update",
        payload: [
          {
            key: { remoteJid: OTHER, fromMe: false, id: "edited-message" },
            update: {
              message: {
                editedMessage: { message: { conversation: "Edited text" } },
              },
              messageTimestamp: TIMESTAMP,
            },
          },
        ],
      },
    ]);
  });

  test("preserves another user's legitimate message revoke", async () => {
    const h = harness();
    const envelope = protocolMessage(
      {
        type: Type.REVOKE,
        key: { id: "revoked-message" },
      },
      false,
    );
    await processMessage(envelope, h.context);
    expect(h.events).toEqual([
      {
        event: "messages.update",
        payload: [
          {
            key: { remoteJid: OTHER, fromMe: false, id: "revoked-message" },
            update: {
              message: null,
              messageStubType: proto.WebMessageInfo.StubType.REVOKE,
              key: envelope.key,
            },
          },
        ],
      },
    ]);
  });
});
