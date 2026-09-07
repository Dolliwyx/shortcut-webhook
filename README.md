# Shortcut-to-Discord webhook relay

Use this Node.js service to notify one Discord user about meaningful changes to Shortcut Stories they own. The service has no external dependencies.

The relay verifies each Shortcut webhook signature, filters the event, and sends one Discord message for each eligible event. Messages include Story links and a compact change summary. Only the configured Discord user can receive a mention.

## Supported notifications

The relay notifies you about these changes to Stories owned by the configured Shortcut member:

- Story creation.
- Addition or removal of the configured member as an owner. Removal remains eligible even when the member no longer owns the Story.
- Workflow state, deadline, or estimate changes.
- Comment creation, with a short excerpt when available. Commenter display names are optional.

The relay ignores actions performed by the configured member. It also ignores unowned Stories, tasks, deletions, Epic-only events, and changes limited to titles, descriptions, or labels.

If ownership or a comment's relationship to a Story is ambiguous, the relay ignores the change. Real comment-update events are not yet supported.

## Before you begin

You need the following:

- Node.js 24.16.x. The `.nvmrc` file specifies version 24.16.0.
- pnpm 11.22.0 or a later 11.x release.
- Permission to configure a Shortcut outgoing webhook and a Discord incoming webhook.
- A public HTTPS URL that forwards requests to the relay. For local testing, you can use an HTTPS tunnel.

Keep your `.env` file, API tokens, Discord webhook URL, and raw workspace payloads private. Never commit them. The `.gitignore` file excludes local environment files and dependencies but keeps `.env.example` available as a configuration template.

## Set up the relay

### Get your configuration values

1. In the target Discord server's settings, open **Integrations > Webhooks**. Create a webhook for the target channel and copy its URL.
2. In Discord's advanced settings, enable **Developer Mode**. Open the target user's context menu and select **Copy User ID**.
3. Use the Shortcut [List Members API](https://developer.shortcut.com/api/rest/v3#List-Members) to find the target member's `id`. Use this UUID, not their name or email address. You don't need to keep the API token configured in the relay after retrieving the ID.
4. Copy your Shortcut workspace slug from a Story URL. The slug is the path segment immediately after `app.shortcut.com/`.
5. Generate a random webhook secret. For example, if you have OpenSSL installed, run:

   ```sh
   openssl rand -hex 32
   ```

   Save this value for both the relay configuration and the Shortcut outgoing webhook settings.
6. Optional: To show commenter display names, create a token in Shortcut's API Tokens settings for the same workspace. Without a token, the relay sends comments without display names. Lookup failures do not block notification delivery.

### Install and configure the service

1. From the repository root, install the project:

   ```sh
   pnpm install --frozen-lockfile
   ```

2. If you don't already have a `.env` file, copy the configuration template:

   ```sh
   cp .env.example .env
   ```

3. Edit `.env` and replace the placeholders with your configuration values.

The following table describes the environment variables:

| Variable | Required | Description |
| --- | --- | --- |
| `SHORTCUT_WEBHOOK_SECRET` | Yes | Nonempty secret shared with the Shortcut outgoing webhook. |
| `SHORTCUT_MEMBER_ID` | Yes | Shortcut member UUID used to filter ownership and suppress that member's actions. |
| `SHORTCUT_WORKSPACE_SLUG` | Yes | Workspace path segment used in Story links. |
| `DISCORD_WEBHOOK_URL` | Yes | Incoming webhook URL in the format `https://discord.com/api/webhooks/WEBHOOK_ID/WEBHOOK_TOKEN`. Replace `WEBHOOK_ID` with the numeric webhook ID and `WEBHOOK_TOKEN` with its token. |
| `DISCORD_USER_ID` | Yes | Numeric Discord user ID to mention. |
| `SHORTCUT_API_TOKEN` | No | Token for commenter display-name lookups. Leave blank to disable lookups. |
| `PORT` | No | Listening port from `1` through `65535`. Defaults to `3000`. |
| `SHORTCUT_DIAGNOSTICS` | No | Set to `1` for temporary local event-structure diagnostics. Leave set to `0` in production. |

### Start the service

1. Run the automated tests:

   ```sh
   pnpm test
   ```

2. Start the relay:

   ```sh
   pnpm start
   ```

   This command loads `.env` through Node.js environment-file support. Missing or invalid configuration causes startup to fail with a `configuration_error` log.

3. In another terminal, check the health endpoint:

   ```sh
   curl -i http://localhost:3000/healthz
   ```

   If you configured a different port, replace `3000` with that port. Expect `200 OK`. The endpoint checks the relay process, not its connections to Shortcut or Discord.

### Connect the Shortcut webhook

Before you register the webhook, expose the local port through an HTTPS tunnel or [deploy the relay](#deploy-the-relay).

1. In Shortcut's outgoing webhook settings, set the destination to:

   ```text
   https://PUBLIC_HOST/shortcut
   ```

   Replace `PUBLIC_HOST` with your tunnel or deployment hostname.

2. Set the webhook secret to the exact value of `SHORTCUT_WEBHOOK_SECRET`.
3. Enable the webhook for the workspace.

The relay receives workspace-wide events and filters them itself. It rejects unsigned requests. For the request contract, see the [Shortcut outgoing webhook documentation](https://developer.shortcut.com/api/webhook/v1).

### Verify notification delivery

For these checks, use the Shortcut member configured in `SHORTCUT_MEMBER_ID` as your account.

1. Ask a different Shortcut member to change the workflow state or add a comment on a Story you own.
2. Confirm that one Discord message appears, mentions the configured user, and links to the correct Story.
3. Make a change yourself. Confirm that no message appears.
4. Ask another member to change a Story you don't own. Confirm that no message appears.

A visible Discord mention doesn't guarantee a push notification. Channel permissions and user notification settings still apply.

## Deploy the relay

Use a host that supports a long-running Node.js process, environment variables, and public HTTPS.

1. Configure the host to use Node.js 24.16.x.
2. Install the project:

   ```sh
   pnpm install --frozen-lockfile
   ```

3. Set the environment variables through the hosting platform's configuration or secret store. Leave diagnostics disabled.
4. Set the start command to:

   ```sh
   node index.js
   ```

   Use this command when the host injects environment variables. Unlike `pnpm start`, it doesn't require a `.env` file.

5. Configure the host or reverse proxy to forward HTTPS requests to the configured `PORT`. The Node.js process serves HTTP; the host or proxy provides HTTPS. Preserve the request body and `Payload-Signature` header because signatures depend on the exact request bytes.
6. Set the health-check path to `/healthz`.
7. [Connect the Shortcut webhook](#connect-the-shortcut-webhook) to the deployed URL.
8. [Verify notification delivery](#verify-notification-delivery).

## Run with Docker

Install Docker and make sure its daemon is running. You don't need Node.js or pnpm on the host for this option.

1. Create `.env` from `.env.example` if it doesn't already exist, then fill in the configuration values listed above. Use `KEY=value` lines without surrounding quotes and keep `PORT=3000`. Docker injects these variables at runtime; `.dockerignore` keeps the file out of the image.

2. From the repository root, build the image:

   ```sh
   docker build -t shortcut-webhook .
   ```

3. Start the container:

   ```sh
   docker run -d \
     --name shortcut-webhook \
     --init \
     --restart unless-stopped \
     --env-file .env \
     -p 127.0.0.1:8800:3000 \
     shortcut-webhook
   ```

   This maps host port **8800** to container port **3000**, accessible only from the host. Keep `PORT=3000` in `.env`; to change the host port, replace only `8800` in the mapping. The restart policy restarts the container after crashes and VPS reboots unless you explicitly stop it. Ensure Docker starts on boot.

4. Check health and follow logs:

   ```sh
   curl -i http://127.0.0.1:8800/healthz
   docker logs -f shortcut-webhook
   ```

   Expect `200 OK`. Configure a host-installed Caddy or Nginx reverse proxy to provide public HTTPS and forward requests to `127.0.0.1:8800`. Then [connect the Shortcut webhook](#connect-the-shortcut-webhook) and [verify notification delivery](#verify-notification-delivery).

After changing `.env`, stop and remove the container, then repeat the `docker run` command above:

```sh
docker stop shortcut-webhook
docker rm shortcut-webhook
```

Restarting alone doesn't reload environment variables. For code changes, also rebuild the image before creating the replacement container.

## Troubleshoot the relay

Use the following table to interpret responses and common symptoms:

| Response or symptom | Explanation and action |
| --- | --- |
| Startup exits with `configuration_error` | Check required values and formats against the environment-variable table. The log omits secret values. |
| Webhook returns `204` | The relay delivered or intentionally ignored the event. Check the structured log's `outcome`. |
| Webhook returns `400` | The request contains invalid JSON, an unsupported webhook version, or an invalid event structure. |
| Webhook returns `401` | The signature is missing or invalid. Check that the secrets match and the proxy preserves the request body. |
| Webhook returns `413` | The request body exceeds the 1 MiB limit. |
| Webhook returns `502` | Discord rejected the request, or delivery failed or timed out. Check the webhook URL and the logged `discordStatus`, when available. |
| Your own change produces no message | This is expected. The relay suppresses actions by `SHORTCUT_MEMBER_ID`. Test with a teammate. |
| A comment has no display name | Check the optional API token. Missing author information or lookup failures also cause the relay to omit the name. |

Normal logs contain processing metadata, not Story names, comment text, or secrets. For unexpected event structures, follow the [local diagnostic instructions](test/fixtures/README.md#collect-local-shape-diagnostics). Leave diagnostics disabled in production.

## Run tests

To run the automated tests, use:

```sh
pnpm test
```

Tests cover filtering, formatting, signatures, configuration, HTTP responses, Discord delivery, and commenter-name lookups. External service calls are mocked. These tests don't verify a live deployment; also complete the [notification delivery checks](#verify-notification-delivery).

## Limitations

- The relay supports one Shortcut workspace, one Shortcut member, and one Discord channel.
- There is no database, queue, retry mechanism, or duplicate suppression. Failed deliveries can lose notifications. Duplicate or replayed valid events can produce duplicate messages.
- Discord delivery has a 5-second timeout. Optional commenter lookups can add up to 2 seconds.
- Real comment-update events remain unsupported until their relationship to Stories is confirmed.

For the full scope, security contract, and acceptance criteria, see the [MVP specification](MVP.md). For confirmed and provisional webhook structures, see the [test fixture documentation](test/fixtures/README.md).
