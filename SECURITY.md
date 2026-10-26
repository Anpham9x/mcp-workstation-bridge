# Security

Run as a normal Windows user. The bridge can read/write files and control the desktop with the privileges of that account.

Local mode binds to 127.0.0.1 and is for trusted clients on the same machine. Do not forward its port through a tunnel. Untrusted programs running under the same Windows account are outside its security boundary.

Owner access is disabled when no local owner policy exists. Do not copy another installation's `.ai` directory, tokens, OAuth identities, attachments, or logs. Scope workspace access with `MCP_WORKSPACE_ROOTS` (Windows path separator: semicolon). Raw PowerShell is not a filesystem sandbox.

Remote deployment requires your own HTTPS endpoint and validated OAuth issuer, audience, resource URL and scopes. Never use a shared owner's credentials. Review `src/security/oauth.ts` before deploying remotely. Local mode does not provide remote authentication.

Report suspected secrets privately to the repository owner. Removing a file in a new commit does not remove it from Git history; revoke leaked credentials and clean history before making an existing private repository public.
