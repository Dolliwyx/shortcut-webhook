import http from 'node:http';
import { pathToFileURL } from 'node:url';

import { eventShape } from './src/diagnostics.js';
import { lookupMemberNames } from './src/members.js';
import { processEvent } from './src/relay.js';
import { verifySignature } from './src/signature.js';

const MAX_BODY_BYTES = 1024 * 1024;
const DISCORD_TIMEOUT_MS = 5_000;

const GENERIC_BODIES = {
  200: 'OK',
  400: 'Bad Request',
  401: 'Unauthorized',
  404: 'Not Found',
  405: 'Method Not Allowed',
  413: 'Payload Too Large',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
};

class RequestBodyTooLargeError extends Error {}

/**
 * Read and validate the process configuration without exposing secret values.
 *
 * @param {NodeJS.ProcessEnv | Record<string, unknown>} env
 */
export function loadConfig(env = process.env) {
  const errors = [];
  const secret = env?.SHORTCUT_WEBHOOK_SECRET;
  const shortcutApiToken = env?.SHORTCUT_API_TOKEN ?? '';
  const shortcutMemberId = env?.SHORTCUT_MEMBER_ID;
  const workspaceSlug = env?.SHORTCUT_WORKSPACE_SLUG;
  const discordWebhookUrl = env?.DISCORD_WEBHOOK_URL;
  const discordUserId = env?.DISCORD_USER_ID;
  const suppliedPort = env?.PORT;

  if (!isNonEmptyString(secret)) {
    errors.push('SHORTCUT_WEBHOOK_SECRET');
  }

  if (typeof shortcutApiToken !== 'string' || (shortcutApiToken !== '' && !/^[\x21-\x7e]+$/.test(shortcutApiToken))) {
    errors.push('SHORTCUT_API_TOKEN');
  }

  if (!isUuid(shortcutMemberId)) {
    errors.push('SHORTCUT_MEMBER_ID');
  }

  if (!isWorkspaceSlug(workspaceSlug)) {
    errors.push('SHORTCUT_WORKSPACE_SLUG');
  }

  if (!isDiscordWebhookUrl(discordWebhookUrl)) {
    errors.push('DISCORD_WEBHOOK_URL');
  }

  if (!isDecimalString(discordUserId)) {
    errors.push('DISCORD_USER_ID');
  }

  let port = 3000;
  if (suppliedPort !== undefined) {
    if (!isDecimalString(suppliedPort)) {
      errors.push('PORT');
    } else {
      port = Number(suppliedPort);
      if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
        errors.push('PORT');
      }
    }
  }

  if (errors.length > 0) {
    throw new Error(`Invalid configuration: ${errors.join(', ')}`);
  }

  return {
    shortcutWebhookSecret: secret,
    shortcutApiToken,
    shortcutMemberId,
    workspaceSlug,
    discordWebhookUrl,
    discordUserId,
    port,
    diagnostics: env?.SHORTCUT_DIAGNOSTICS === '1',
  };
}

/**
 * Create the HTTP server without binding a port. The optional dependencies are
 * intentionally injectable for boundary tests.
 *
 * @param {{
 *   shortcutWebhookSecret: string,
 *   shortcutApiToken?: string,
 *   shortcutMemberId: string,
 *   workspaceSlug: string,
 *   discordWebhookUrl: string | URL,
 *   discordUserId: string,
 *   port?: number,
 *   diagnostics?: boolean,
 * }} config
 * @param {{fetch?: typeof globalThis.fetch, fetchImpl?: typeof globalThis.fetch, logger?: ((line: string) => void) | Console, timeout?: number, timeoutMs?: number, memberTimeoutMs?: number}} options
 */
export function createServer(config, options = {}) {
  const fetchImpl = options.fetch ?? options.fetchImpl ?? globalThis.fetch;
  const logger = options.logger ?? ((line) => console.log(line));
  const timeoutMs = options.timeoutMs ?? options.timeout ?? DISCORD_TIMEOUT_MS;

  return http.createServer((request, response) => {
    void handleRequest(request, response, config, { fetchImpl, logger, timeoutMs, memberTimeoutMs: options.memberTimeoutMs });
  });
}

async function handleRequest(request, response, config, dependencies) {
  const startedAt = Date.now();
  const pathname = requestPathname(request.url);

  if (pathname === '/healthz') {
    if (request.method !== 'GET') {
      discardRequestBody(request);
      sendResponse(response, 405, { Allow: 'GET' });
      return;
    }

    sendResponse(response, 200);
    return;
  }

  if (pathname !== '/shortcut') {
    discardRequestBody(request);
    sendResponse(response, 404);
    return;
  }

  if (request.method !== 'POST') {
    discardRequestBody(request);
    sendResponse(response, 405, { Allow: 'POST' });
    return;
  }

  let rawBody;
  try {
    rawBody = await readRawBody(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      logOutcome(dependencies.logger, undefined, 'invalid', startedAt);
      sendResponse(response, 413);
      return;
    }

    logOutcome(dependencies.logger, undefined, 'invalid', startedAt);
    sendResponse(response, 400);
    return;
  }

  let signatureValid = false;
  try {
    signatureValid = await verifySignature(
      rawBody,
      signatureHeader(request),
      config.shortcutWebhookSecret,
    );
  } catch {
    signatureValid = false;
  }

  if (!signatureValid) {
    logOutcome(dependencies.logger, undefined, 'invalid', startedAt);
    sendResponse(response, 401);
    return;
  }

  let event;
  try {
    event = JSON.parse(rawBody.toString('utf8'));
  } catch {
    logOutcome(dependencies.logger, undefined, 'invalid', startedAt);
    sendResponse(response, 400);
    return;
  }

  let result;
  let validationError;
  const relayOptions = {
    shortcutMemberId: config.shortcutMemberId,
    workspaceSlug: config.workspaceSlug,
    discordUserId: config.discordUserId,
    onInvalid: config.diagnostics ? (issue) => { validationError = issue; } : undefined,
  };
  try {
    result = await processEvent(event, relayOptions);
  } catch {
    logOutcome(dependencies.logger, undefined, 'error', startedAt);
    sendResponse(response, 500);
    return;
  }

  if (!result || typeof result !== 'object') {
    logOutcome(dependencies.logger, undefined, 'error', startedAt);
    sendResponse(response, 500);
    return;
  }

  if (config.diagnostics) {
    writeLog(dependencies.logger, {
      outcome: 'diagnostic',
      eventOutcome: result.outcome,
      validationError,
      memberChecks: {
        selfAuthored: event?.member_id === config.shortcutMemberId,
        aggregateOwnerMatch: Array.isArray(event?.owner_ids) && event.owner_ids.includes(config.shortcutMemberId),
      },
      shape: eventShape(event),
    });
  }

  if (result.outcome === 'invalid') {
    logOutcome(dependencies.logger, result, 'invalid', startedAt);
    sendResponse(response, 400);
    return;
  }

  if (result.outcome === 'ignored') {
    logOutcome(dependencies.logger, result, 'ignored', startedAt);
    sendResponse(response, 204);
    return;
  }

  if (result.outcome !== 'deliver' || result.payload === undefined) {
    logOutcome(dependencies.logger, result, 'error', startedAt);
    sendResponse(response, 500);
    return;
  }

  if (config.shortcutApiToken && result.commentAuthorIds.length > 0) {
    const authorNames = await lookupMemberNames(
      result.commentAuthorIds, config.shortcutApiToken, dependencies.fetchImpl, dependencies.memberTimeoutMs,
    );
    // Reformat through the same pure path so names obey the content limit.
    result = processEvent(event, { ...relayOptions, authorNames });
  }

  const discordResult = await postToDiscord(
    config.discordWebhookUrl,
    result.payload,
    dependencies.fetchImpl,
    dependencies.timeoutMs,
  );

  if (discordResult.ok) {
    logOutcome(
      dependencies.logger,
      result,
      'delivered',
      startedAt,
      discordResult.status,
    );
    sendResponse(response, 204);
    return;
  }

  logOutcome(
    dependencies.logger,
    result,
    'discord_failed',
    startedAt,
    discordResult.status,
  );
  sendResponse(response, 502);
}

function isNonEmptyString(value) {
  return typeof value === 'string' && value.length > 0;
}

function isUuid(value) {
  return (
    typeof value === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}

function isWorkspaceSlug(value) {
  return (
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\s/?#]/u.test(value) &&
    value !== '.' &&
    value !== '..'
  );
}

function isDecimalString(value) {
  return typeof value === 'string' && /^[0-9]+$/.test(value);
}

function isDiscordWebhookUrl(value) {
  if (!isNonEmptyString(value)) {
    return false;
  }

  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return false;
  }

  const authority = /^https:\/\/([^/?#]*)/i.exec(value)?.[1];
  if (!authority || !/^discord\.com$/i.test(authority)) {
    return false;
  }

  return (
    parsed.origin === 'https://discord.com' &&
    parsed.username === '' &&
    parsed.password === '' &&
    parsed.port === '' &&
    /^\/api\/webhooks\/[0-9]+\/[^/]+$/.test(parsed.pathname)
  );
}

function requestPathname(requestUrl) {
  try {
    return new URL(requestUrl ?? '/', 'http://localhost').pathname;
  } catch {
    return '';
  }
}

function discardRequestBody(request) {
  request.resume();
}

function signatureHeader(request) {
  const header = request.headers['payload-signature'];
  return typeof header === 'string' ? header : undefined;
}

function readRawBody(request, maxBytes) {
  const contentLength = request.headers['content-length'];
  if (
    typeof contentLength === 'string' &&
    /^[0-9]+$/.test(contentLength) &&
    Number(contentLength) > maxBytes
  ) {
    discardRequestBody(request);
    return Promise.reject(new RequestBodyTooLargeError());
  }

  return new Promise((resolve, reject) => {
    const chunks = [];
    let totalBytes = 0;
    let settled = false;

    const cleanup = () => {
      request.off('data', onData);
      request.off('end', onEnd);
      request.off('error', onError);
      request.off('aborted', onAborted);
    };

    const settle = (callback, value) => {
      if (settled) {
        return;
      }
      settled = true;
      cleanup();
      callback(value);
    };

    const onData = (chunk) => {
      const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      if (totalBytes + buffer.length > maxBytes) {
        discardRequestBody(request);
        settle(reject, new RequestBodyTooLargeError());
        return;
      }

      totalBytes += buffer.length;
      chunks.push(buffer);
    };

    const onEnd = () => settle(resolve, Buffer.concat(chunks, totalBytes));
    const onError = (error) => settle(reject, error);
    const onAborted = () => settle(reject, new Error('Request aborted'));

    request.on('data', onData);
    request.once('end', onEnd);
    request.once('error', onError);
    request.once('aborted', onAborted);
  });
}

async function postToDiscord(webhookUrl, payload, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let timer;

  try {
    const endpoint = new URL(webhookUrl);
    endpoint.searchParams.set('wait', 'true');

    const timedResponse = new Promise((resolve) => {
      timer = setTimeout(() => {
        controller.abort();
        resolve(undefined);
      }, timeoutMs);
    });

    const fetchedResponse = Promise.resolve().then(() =>
      fetchImpl(endpoint.toString(), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        redirect: 'error',
        signal: controller.signal,
      }),
    );

    const response = await Promise.race([fetchedResponse, timedResponse]);
    if (!response) {
      return { ok: false };
    }

    const status = typeof response.status === 'number' ? response.status : undefined;
    return {
      ok: typeof status === 'number' ? status >= 200 && status < 300 : response.ok === true,
      status,
    };
  } catch {
    return { ok: false };
  } finally {
    clearTimeout(timer);
  }
}

function logOutcome(logger, result, outcome, startedAt, discordStatus) {
  const metadata = {
    outcome,
    latencyMs: Math.max(0, Date.now() - startedAt),
  };

  if (typeof result?.eventId === 'string') {
    metadata.eventId = result.eventId;
  }

  const storyIds = metadataValues(result?.storyIds);
  if (storyIds) {
    metadata.storyIds = storyIds;
  }

  const actionTypes = metadataValues(result?.actionTypes);
  if (actionTypes) {
    metadata.actionTypes = actionTypes;
  }

  if (typeof discordStatus === 'number') {
    metadata.discordStatus = discordStatus;
  }

  writeLog(logger, metadata);
}

function writeLog(logger, metadata) {
  const line = JSON.stringify(metadata);
  try {
    if (typeof logger === 'function') {
      logger(line);
    } else if (typeof logger?.info === 'function') {
      logger.info(line);
    } else if (typeof logger?.log === 'function') {
      logger.log(line);
    } else if (typeof logger?.error === 'function') {
      logger.error(line);
    }
  } catch {
    // Logging must not affect webhook handling.
  }
}

function metadataValues(values) {
  if (!Array.isArray(values)) {
    return undefined;
  }

  return values
    .filter((value) => typeof value === 'string' || typeof value === 'number')
    .map(String);
}

function sendResponse(response, statusCode, headers = {}) {
  response.statusCode = statusCode;
  for (const [name, value] of Object.entries(headers)) {
    response.setHeader(name, value);
  }

  if (statusCode === 204) {
    response.end();
    return;
  }

  const body = GENERIC_BODIES[statusCode] ?? GENERIC_BODIES[500];
  response.setHeader('Content-Type', 'text/plain; charset=utf-8');
  response.setHeader('Content-Length', Buffer.byteLength(body));
  response.end(body);
}

function startFromCommandLine() {
  let config;
  try {
    config = loadConfig(process.env);
  } catch {
    process.stderr.write(`${JSON.stringify({ outcome: 'configuration_error' })}\n`);
    process.exitCode = 1;
    return;
  }

  createServer(config).listen(config.port);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  startFromCommandLine();
}
