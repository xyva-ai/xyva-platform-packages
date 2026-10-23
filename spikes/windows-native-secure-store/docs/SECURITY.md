# Isolated native Windows secure-store adapter

This Phase-12B.1 spike is deliberately not imported by the agent. It uses only
the C Node-API surface (`node_api.h`, N-API 8), Windows handles, and documented
Win32 security APIs. It has no child process, shell, PATH lookup, credential,
network, or filesystem fallback.

The loader is Windows-x64-only and fails closed if the package-owned addon is
absent. The CI build is reproducible from the pinned `node-gyp` dependency;
headers are the exact Node release headers selected by CI. ARM64 requires a
separate signed build and native execution; it is not validated by this spike.

The public spike API accepts an existing, explicitly supplied test root and a
single safe leaf component. It creates a protected object with an explicit
owner and only user, SYSTEM, and BUILTIN\\Administrators full-control ACEs,
then verifies the opened handle before and after a file write. It never logs
content or paths. This is an exploration artifact: it still requires the
handle-relative parent-chain implementation and independent security review
before any production integration.
