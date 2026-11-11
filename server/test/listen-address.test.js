import test from "node:test";
import assert from "node:assert/strict";
import { resolveListenAddress } from "../config/listen.js";

test("HOST and PORT from the environment win", () => {
    assert.deepEqual(resolveListenAddress({ HOST: "0.0.0.0", PORT: "10000" }),
        { host: "0.0.0.0", port: 10000, hostSource: "HOST", portSource: "PORT" });
    assert.equal(resolveListenAddress({ HOST: " 0.0.0.0 ", RENDER: "true" }).host, "0.0.0.0");
});

test("on Render without HOST the server listens on all interfaces", () => {
    assert.deepEqual(resolveListenAddress({ RENDER: "true", PORT: "10000" }),
        { host: "0.0.0.0", port: 10000, hostSource: "RENDER default", portSource: "PORT" });
    assert.equal(resolveListenAddress({ RENDER: "true", HOST: "" }).host, "0.0.0.0");
});

test("locally the server stays on loopback and port 3001", () => {
    assert.deepEqual(resolveListenAddress({}), { host: "127.0.0.1", port: 3001, hostSource: "local default", portSource: "default" });
    assert.equal(resolveListenAddress({ PORT: "abc" }).port, 3001);
});
