"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { contentHash } = require("../out/hash.js");

// The daemon compares this hash with process::content_hash() in
// crates/core/src/process.rs, which pins the same vectors in
// content_hash_matches_the_extension. If either side changes encoding or
// case, both tests fail.

test("hashes the empty string to the SHA-256 empty digest", () => {
  assert.equal(
    contentHash(""),
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
  );
});

test("hashes the UTF-8 bytes, not UTF-16 code units", () => {
  // 68 c3 a9 6c 6c 6f 20 e2 80 94 20 e2 9c 93 0d 0a, hashed by sha256sum.
  assert.equal(
    contentHash("h\u00e9llo \u2014 \u2713\r\n"),
    "232bb729048dfc77ee393b74f45d3d31dfb2b2f2ed51292230fe66296c29c7cd"
  );
});

test("is lowercase hex, 64 characters", () => {
  assert.match(contentHash("abc"), /^[0-9a-f]{64}$/);
});

test("keeps line endings: CRLF and LF text hash differently", () => {
  assert.notEqual(contentHash("a\r\nb"), contentHash("a\nb"));
});
