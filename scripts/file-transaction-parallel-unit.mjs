#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  commitFileTransaction,
  commitPreparedFileTransaction
} from "../dist/fileTransaction.js";

const root = await fs.mkdtemp(path.join(os.tmpdir(), "least-tx-"));

// --- prepared concurrent create ---
{
  const files = Array.from({ length: 20 }, (_, i) => {
    const abs = path.join(root, "batch", `f${i}.txt`);
    const content = `hello-${i}\n`;
    return {
      type: "write",
      absPath: abs,
      content,
      buffer: Buffer.from(content, "utf8"),
      original: undefined,
      existed: false
    };
  });
  await commitPreparedFileTransaction(files, { concurrency: 8 });
  for (let i = 0; i < 20; i += 1) {
    const text = await fs.readFile(path.join(root, "batch", `f${i}.txt`), "utf8");
    assert.equal(text, `hello-${i}\n`);
  }
}

// --- overwrite with rollback on inject failure ---
{
  const abs = path.join(root, "rollback", "a.txt");
  await fs.mkdir(path.dirname(abs), { recursive: true });
  await fs.writeFile(abs, "original\n", "utf8");
  const b = path.join(root, "rollback", "b.txt");
  await fs.writeFile(b, "keep\n", "utf8");

  let failed = false;
  try {
    await commitPreparedFileTransaction(
      [
        {
          type: "write",
          absPath: abs,
          content: "new-a\n",
          buffer: Buffer.from("new-a\n", "utf8"),
          original: Buffer.from("original\n", "utf8"),
          existed: true
        },
        {
          type: "write",
          absPath: b,
          content: "new-b\n",
          buffer: Buffer.from("new-b\n", "utf8"),
          original: Buffer.from("keep\n", "utf8"),
          existed: true
        }
      ],
      {
        concurrency: 2,
        injectFailure: { stage: "rename", index: 1 }
      }
    );
  } catch (error) {
    failed = true;
    assert.match(String(error.message), /Injected transaction failure/);
  }
  assert.equal(failed, true);
  assert.equal(await fs.readFile(abs, "utf8"), "original\n");
  assert.equal(await fs.readFile(b, "utf8"), "keep\n");
}

// --- duplicate path rejected ---
{
  let rejected = false;
  try {
    await commitPreparedFileTransaction([
      {
        type: "write",
        absPath: path.join(root, "dup.txt"),
        content: "a",
        buffer: Buffer.from("a"),
        original: undefined,
        existed: false
      },
      {
        type: "write",
        absPath: path.join(root, "dup.txt"),
        content: "b",
        buffer: Buffer.from("b"),
        original: undefined,
        existed: false
      }
    ]);
  } catch (error) {
    rejected = true;
    assert.match(String(error.message), /Duplicate transaction target/);
  }
  assert.equal(rejected, true);
}

// --- compatibility wrapper ---
{
  const abs = path.join(root, "compat.txt");
  await commitFileTransaction([{ type: "write", absPath: abs, content: "compat\n" }]);
  assert.equal(await fs.readFile(abs, "utf8"), "compat\n");
}

// --- createDirs=false does not mkdir missing parents ---
{
  const abs = path.join(root, "no-mkdir", "x.txt");
  let failed = false;
  try {
    await commitPreparedFileTransaction(
      [
        {
          type: "write",
          absPath: abs,
          content: "x\n",
          buffer: Buffer.from("x\n"),
          original: undefined,
          existed: false,
          createDirs: false
        }
      ],
      { concurrency: 2 }
    );
  } catch {
    failed = true;
  }
  assert.equal(failed, true);
  await assert.rejects(() => fs.access(abs), /ENOENT/);
}

await fs.rm(root, { recursive: true, force: true });
console.log("file-transaction-parallel-unit: ok");
