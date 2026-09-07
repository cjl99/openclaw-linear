import { test, expect } from "vitest";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, type Event } from "../src/store.js";
import { preparePrompt } from "../src/context.js";
const event: Event = {
  id: "event",
  organizationId: "org",
  sessionId: "session",
  issueId: "issue",
  action: "prompted",
  prompt: "你读到什么了",
};
function fixture(check: (store: Store) => void) {
  const dir = mkdtempSync(join(tmpdir(), "linear-simple-context-"));
  const store = new Store(dir);
  try {
    check(store);
  } finally {
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}
test("ordinary followup is verbatim, ignoring old work records and ledgers", () =>
  fixture((store) => {
    store.set("context-work:org:session", { answer: "old assistant reply" });
    store.set("context-ledger:org:session", { comments: ["old comment"] });
    expect(preparePrompt(event, store).prompt).toBe(event.prompt);
    expect(existsSync(join(store.dir, "context"))).toBe(false);
    expect(existsSync(join(store.dir, "long-prompts"))).toBe(false);
  }));
test("created promptContext is preserved", () =>
  fixture((store) => {
    const prompt = "Issue MAR-10\nDescription\nComment: hello";
    expect(
      preparePrompt({ ...event, action: "created", prompt }, store).prompt,
    ).toBe(prompt);
  }));
test("guidance delivered once, changed guidance delivered again", () =>
  fixture((store) => {
    const first = preparePrompt(
      { ...event, guidance: [{ body: "Use isolated checkout" }] },
      store,
    );
    expect(first.prompt).toContain("Use isolated checkout");
    first.commit();
    expect(preparePrompt(event, store).prompt).toBe(event.prompt);
    const changed = preparePrompt(
      { ...event, guidance: [{ body: "Read only" }] },
      store,
    );
    expect(changed.prompt).toContain("Read only");
    changed.commit();
    expect(preparePrompt(event, store).prompt).toBe(event.prompt);
  }));
test("failed run does not mark guidance delivered; sessions stay isolated", () =>
  fixture((store) => {
    preparePrompt({ ...event, guidance: ["Read only"] }, store);
    expect(preparePrompt(event, store).prompt).toContain("Read only");
    expect(preparePrompt({ ...event, sessionId: "other" }, store).prompt).toBe(
      event.prompt,
    );
  }));
test("existing guidance not duplicated and clearing is explicit once", () =>
  fixture((store) => {
    const first = preparePrompt(
      {
        ...event,
        action: "created",
        prompt: "Task\nRead only",
        guidance: [{ body: "Read only" }],
      },
      store,
    );
    expect(first.prompt).toBe("Task\nRead only");
    first.commit();
    const cleared = preparePrompt({ ...event, guidance: [] }, store);
    expect(cleared.prompt).toContain("cleared");
    cleared.commit();
    expect(preparePrompt(event, store).prompt).toBe(event.prompt);
  }));
test("only long input uses a private complete original", () =>
  fixture((store) => {
    const prompt = "背景".repeat(15000) + "最后的关键要求";
    const result = preparePrompt({ ...event, prompt }, store);
    const dir = join(store.dir, "long-prompts");
    const file = join(dir, readdirSync(dir)[0]);
    expect(readFileSync(file, "utf8")).toBe(prompt);
    expect(statSync(file).mode & 0o777).toBe(0o600);
    expect(result.prompt).toContain(file);
    expect(result.prompt.length).toBeLessThan(14000);
    expect(result.prompt).not.toContain("本轮覆盖说明");
  }));
