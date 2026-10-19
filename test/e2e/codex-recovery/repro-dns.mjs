import dns from "node:dns";
import { syncBuiltinESMExports } from "node:module";
const original = dns.lookup;
dns.lookup = function (...args) {
  const [host, options, callback] = args;
  if (host !== "managed-devbox.repro.invalid") {
    return original.apply(this, args);
  }
  const onLookup = typeof options === "function" ? options : callback;
  const lookupOptions = typeof options === "function" ? {} : options;
  queueMicrotask(() =>
    lookupOptions?.all
      ? onLookup(null, [{ address: "127.0.0.1", family: 4 }])
      : onLookup(null, "127.0.0.1", 4),
  );
};
syncBuiltinESMExports();
