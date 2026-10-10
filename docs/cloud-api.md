# Official WhatsApp Cloud API

Choose the connection that matches your account. The existing `baileys` provider
remains the default and uses a phone's linked-device session. `cloud-api` uses
Meta's official WhatsApp Business Platform for business DMs. Switching preserves
the other provider's configuration and Baileys auth; it does not transfer messages,
contacts, groups, or a device session.

## Before choosing this provider

This community plugin is not endorsed by Meta or Anthropic. Official API access
avoids the unofficial linked-device protocol, but does not establish policy
eligibility. Meta's current business terms restrict some general-purpose AI
provider use. Confirm your particular use is permitted before enabling this
backend: [Business Solution Terms](https://www.whatsapp.com/legal/business-solution-terms)
and [Business Messaging Policy](https://business.whatsapp.com/policy).

Meta fees depend on applicable categories, destination markets, and current
rules. A service provider may charge separately, and hosting and Claude costs
remain separate. Consult [official pricing](https://business.whatsapp.com/products/platform-pricing)
and [official FAQ](https://whatsappbusiness.com/resources/faq/) rather than relying
on an embedded rate or assuming all messages are free.

## Configure privately

In your own interactive terminal, from the plugin directory:

```sh
bun scripts/provider.ts choose
# Or choose explicitly:
bun scripts/provider.ts set cloud-api
bun scripts/provider.ts status
```

Credentials are entered privately through terminal prompts. Never paste the
access token, app secret, or verify token into Claude or WhatsApp. The CLI writes
`~/.whatsapp-channel/.env` with mode `600`, preserving unrelated keys. Set
`WHATSAPP_STATE_DIR` to use another directory. For different personal and business
numbers, use separate state directories so access, owner and conversation state
remain independent.

The equivalent environment-variable names are below. These values are
**placeholders**, not credentials; do not commit a populated file:

```dotenv
WHATSAPP_PROVIDER=cloud-api
WHATSAPP_CLOUD_PHONE_NUMBER_ID=<META_PHONE_NUMBER_ID>
WHATSAPP_CLOUD_ACCESS_TOKEN=<PRIVATE_ACCESS_TOKEN>
WHATSAPP_CLOUD_APP_SECRET=<PRIVATE_META_APP_SECRET>
WHATSAPP_CLOUD_VERIFY_TOKEN=<PRIVATE_RANDOM_VERIFY_TOKEN>
```

The phone number ID is Meta's resource ID, not your phone number or WABA ID.
Use a suitable token with `whatsapp_business_messaging`; managing/subscribing the
WABA also needs `whatsapp_business_management`. Plugin user configuration can
provide the same values. A nonempty process/plugin value takes precedence over
the saved file; empty or unresolved plugin fields fall back to saved values.
Restart every server using that state directory after configuration changes.

Plugin settings are passed to the MCP subprocess, not the SessionStart hook.
If you configure only plugin settings, check the effective provider with the MCP
`status` tool and skip any linked-device setup guidance. Terminal configuration
lets both the hook and MCP server see the selected provider.

Optional settings:

| Variable                      | Default     | Purpose                                |
| ----------------------------- | ----------- | -------------------------------------- |
| `WHATSAPP_CLOUD_API_VERSION`  | `v26.0`     | Versioned Graph API requests           |
| `WHATSAPP_CLOUD_WEBHOOK_HOST` | `127.0.0.1` | Local listener bind address            |
| `WHATSAPP_CLOUD_WEBHOOK_PORT` | `8787`      | Local listener port                    |
| `WHATSAPP_CLOUD_WEBHOOK_PATH` | `/webhook`  | GET challenge and signed POST callback |

## Enable inbound delivery

1. Create/configure a Meta app, WhatsApp Business Account (WABA), and supported
   business phone number. Obtain the resource ID and token through Meta's setup.
2. Run the MCP server with the Cloud configuration. Put a reverse proxy or tunnel
   with valid public HTTPS in front of `http://127.0.0.1:8787/webhook`. Meta cannot
   reach localhost. Keep the default listener private behind the proxy.
3. Set Meta's callback to your public `https://<YOUR_HOST>/webhook` URL. Use the
   same privately chosen verify token when enrolling the callback.
4. Subscribe the app to your WABA and the `messages` webhook field. A successful
   verification challenge alone does not subscribe the account.
5. Incoming POST requests must carry `X-Hub-Signature-256` calculated with the
   Meta app secret. Forward the header and raw body unchanged through your proxy.
6. Add an allowed personal contact and owner below. Send a real DM from that
   contact to the business number and confirm both receipt and a reply.

`status`, provider status, and doctor can report configuration readiness. They
cannot prove your public proxy, subscription, token, or inbound delivery works.
Use the real DM test before calling setup complete.

Webhook deliveries are acknowledged after admission to a bounded in-memory
queue. An abrupt restart can lose an acknowledged delivery before it reaches
the shared message log. Pending deliveries and attachment lookup do not survive
restart; ask the sender to resend if needed.

## Access and messaging windows

The existing access gate applies to Cloud DMs. The business number is not
automatically allowed or made owner; use your personal contact instead:

```sh
bun scripts/access.ts allow <PERSONAL_DIGITS>@s.whatsapp.net
bun scripts/access.ts set owner <PERSONAL_DIGITS>@s.whatsapp.net
bun scripts/access.ts policy allowlist
```

An inbound user message opens/resets a 24-hour service window. Free-form replies,
files and reactions need an open window; delivery/status events and scheduled
tasks do not open one. Outside it, call the explicit `send_template` MCP tool
with an approved template's `name`, `language`, recipient `chat_id`, and optional
`components` array. Parameters must match that approved template. The plugin
does not automatically turn arbitrary Claude text or cron output into templates.
Templates and permission prompts remain subject to Meta's policies, applicable
fees, opt-in requirements, and API-side validation.

## Capabilities in this plugin's first Cloud provider

| Capability                                                          | Linked device          | Cloud API provider                       |
| ------------------------------------------------------------------- | ---------------------- | ---------------------------------------- |
| DM text, incoming images/video/documents/audio/stickers             | Yes                    | Yes                                      |
| Reply, reactions, outgoing files, attachment download/transcription | Yes                    | Yes, subject to service window/API rules |
| Explicit approved template sends                                    | No                     | `send_template`                          |
| Existing groups, group personalities and group cron                 | Yes                    | Unsupported in this implementation       |
| Message editing                                                     | Yes                    | Unsupported in this implementation       |
| Phone address-book/history import                                   | Linked-device features | Unsupported                              |
| Same-number Business App coexistence synchronization                | Not applicable         | Not implemented or promised              |

These are this plugin's implementation limits, not a claim that Meta's entire
platform never offers groups or coexistence. Confirm current Meta eligibility
and requirements separately. Existing group configuration stays on disk when
switching, but does not operate in Cloud mode.

To return to your linked device, run `bun scripts/provider.ts set baileys` in
your terminal and restart. Existing Baileys auth is retained; re-pair only if
WhatsApp has invalidated that linked session.
