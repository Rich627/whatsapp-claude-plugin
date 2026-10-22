import { describe, expect, test } from "bun:test";
import { isInsideAny, parseAttachDirs } from "./attach-dirs";

describe("parseAttachDirs", () => {
  test("unset or blank grants no additional export directories", () => {
    expect(parseAttachDirs(undefined, "/home/u", ":")).toEqual([]);
    expect(parseAttachDirs("", "/home/u", ":")).toEqual([]);
    expect(parseAttachDirs(" : ", "/home/u", ":")).toEqual([]);
  });

  test("a set value with only invalid entries fails closed", () => {
    expect(parseAttachDirs("out:~user/share", "/home/u", ":")).toEqual([]);
  });

  test("splits on the given separator so drive letters survive", () => {
    expect(parseAttachDirs("/a;/b:c", "/home/u", ";")).toEqual(["/a", "/b:c"]);
  });

  test("splits on colons and expands a leading ~", () => {
    expect(parseAttachDirs("~/out:/srv/share", "/home/u", ":")).toEqual([
      "/home/u/out",
      "/srv/share",
    ]);
    expect(parseAttachDirs("~", "/home/u", ":")).toEqual(["/home/u"]);
  });

  test("drops relative entries instead of resolving them against CWD", () => {
    expect(parseAttachDirs("out:./x:~user/y:/ok", "/home/u", ":")).toEqual([
      "/ok",
    ]);
  });

  test("normalizes trailing slashes and dot segments", () => {
    expect(parseAttachDirs("/a/b/:/a/c/../d", "/home/u", ":")).toEqual([
      "/a/b",
      "/a/d",
    ]);
  });
});

describe("isInsideAny", () => {
  test("accepts files inside a listed directory, nested or not", () => {
    expect(isInsideAny("/a/b/f.png", ["/a/b"])).toBe(true);
    expect(isInsideAny("/a/b/c/f.png", ["/x", "/a/b"])).toBe(true);
  });

  test("rejects the directory itself and sibling prefixes", () => {
    expect(isInsideAny("/a/b", ["/a/b"])).toBe(false);
    expect(isInsideAny("/a/bc/f.png", ["/a/b"])).toBe(false);
  });

  test("an empty list allows nothing", () => {
    expect(isInsideAny("/a/b/f.png", [])).toBe(false);
  });
});
