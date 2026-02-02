# NanoClaw Security Model

## Trust Model

| Entity | Trust Level | Rationale |
|--------|-------------|-----------|
| Main group | Trusted | Private self-chat, admin control |
| Non-main groups | Untrusted | Other users may be malicious |
| Sandbox agents | Sandboxed | Isolated execution environment |
| WhatsApp messages | User input | Potential prompt injection |

## Security Boundaries

### 1. Sandbox Isolation (Primary Boundary)

Agents execute in macOS sandboxes (Sandbox Runtime + `sandbox-exec`), providing:
- **Process isolation** - Container processes cannot affect the host
- **Filesystem isolation** - Write access is explicitly allowlisted
- **Ephemeral sandboxes** - Fresh environment per invocation

This is the primary security boundary. Rather than relying on application-level permission checks, the attack surface is limited by what can be written.

### 2. Mount Security

**External Allowlist** - Mount permissions stored at `~/.config/nanoclaw/mount-allowlist.json`, which is:
- Outside project root
- Never allowed into sandboxes
- Cannot be modified by agents

**Default Blocked Patterns:**
```
.ssh, .gnupg, .aws, .azure, .gcloud, .kube, .docker,
credentials, .env, .netrc, .npmrc, id_rsa, id_ed25519,
private_key, .secret
```

**Protections:**
- Symlink resolution before validation (prevents traversal attacks)
- Container path validation (rejects `..` and absolute paths)
- `nonMainReadOnly` option forces read-only for non-main groups

### 3. Session Isolation

Each group has isolated OpenAI session storage at `data/sessions/{group}/openai/`:
- Groups cannot see other groups' conversation history
- Session data includes message history stored by the agent runner
- Prevents cross-group information disclosure

### 4. IPC Authorization

Messages and task operations are verified against group identity:

| Operation | Main Group | Non-Main Group |
|-----------|------------|----------------|
| Send message to own chat | ✓ | ✓ |
| Send message to other chats | ✓ | ✗ |
| Schedule task for self | ✓ | ✓ |
| Schedule task for others | ✓ | ✗ |
| View all tasks | ✓ | Own only |
| Manage other groups | ✓ | ✗ |

### 5. Credential Handling

**Mounted Credentials:**
- OpenAI API key (filtered from `.env`, read-only)

**NOT Mounted:**
- WhatsApp session (`store/auth/`) - host only
- Mount allowlist - external, never mounted
- Any credentials matching blocked patterns

**Credential Filtering:**
Only this environment variable is exposed to sandboxed processes:
```typescript
const allowedVars = ['OPENAI_API_KEY'];
```

## Privilege Comparison

| Capability | Main Group | Non-Main Group |
|------------|------------|----------------|
| Project root access | Write allowlisted | None |
| Group folder | Write allowlisted | Write allowlisted |
| Global memory | Readable | Readable |
| Additional mounts | Configurable | Read-only unless allowed |
| Network access | Unrestricted | Unrestricted |
| IPC tools | All | All |

## Security Architecture Diagram

```
┌──────────────────────────────────────────────────────────────────┐
│                        UNTRUSTED ZONE                             │
│  WhatsApp Messages (potentially malicious)                        │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Trigger check, input escaping
┌──────────────────────────────────────────────────────────────────┐
│                     HOST PROCESS (TRUSTED)                        │
│  • Message routing                                                │
│  • IPC authorization                                              │
│  • Mount validation (external allowlist)                          │
│  • Container lifecycle                                            │
│  • Credential filtering                                           │
└────────────────────────────────┬─────────────────────────────────┘
                                 │
                                 ▼ Explicit mounts only
┌──────────────────────────────────────────────────────────────────┐
│                SANDBOX (ISOLATED)                                 │
│  • Agent execution                                                │
│  • Bash commands (sandboxed)                                      │
│  • File operations (writes limited to allowlist)                  │
│  • Network access (unrestricted)                                  │
│  • Cannot modify security config                                  │
└──────────────────────────────────────────────────────────────────┘
```
