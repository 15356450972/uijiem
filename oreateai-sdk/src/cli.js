#!/usr/bin/env node
import { createOreateClient } from './oreateai.js';
import { registerAccount } from './register.js';
import { createCommandJtProvider } from './jt.js';
import { createAnythingAnalyzerJtProvider } from './anything-analyzer.js';

const parseArgs = (argv) => {
  const result = { _: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (!value.startsWith('--')) {
      result._.push(value);
      continue;
    }
    const [name, inline] = value.slice(2).split('=', 2);
    if (inline !== undefined) result[name] = inline;
    else if (argv[index + 1] && !argv[index + 1].startsWith('--')) result[name] = argv[++index];
    else result[name] = true;
  }
  return result;
};

const output = (value) => process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
const errorOutput = (error) => ({
  ok: false,
  status: 'failed',
  errorCategory: error?.name || 'Error',
  ...(Number.isInteger(error?.httpStatus) ? { httpStatus: error.httpStatus } : {}),
  ...(Number.isInteger(error?.siteCode) ? { siteCode: error.siteCode } : {}),
});
const args = parseArgs(process.argv.slice(2));
const command = args._[0] || 'help';

try {
  if (command === 'probe') {
    const client = createOreateClient();
    await client.bootstrap();
    await client.getTicket();
    output({ ok: true, status: 'ticket_ready' });
  } else if (command === 'register') {
    const jtProvider = args['jt-command']
      ? createCommandJtProvider({
        command: args['jt-command'],
        args: args['jt-arg'] ? [args['jt-arg']] : [],
        timeout: Number(args['jt-timeout'] || 30_000),
      })
      : createAnythingAnalyzerJtProvider({
        url: args['mcp-url'],
        token: process.env.ANYTHING_ANALYZER_MCP_TOKEN,
        runtimeTimeout: Number(args['jt-timeout'] || 10_000),
      });
    const mailboxCredentials = {
      email: args['mail-email'] || process.env.OREATEAI_MAIL_EMAIL,
      client_id: args['mail-client-id'] || process.env.OREATEAI_MAIL_CLIENT_ID,
      refresh_token: args['mail-refresh-token'] || process.env.OREATEAI_MAIL_REFRESH_TOKEN,
      api_url: args['mail-api-url'] || process.env.OREATEAI_MAIL_API_URL,
    };
    const hasMailboxCredentials = Boolean(
      mailboxCredentials.email
      && mailboxCredentials.client_id
      && mailboxCredentials.refresh_token,
    );
    const result = await registerAccount({
      email: hasMailboxCredentials ? undefined : args.email,
      mailboxCredentials,
      password: args.password,
      jtProvider,
      mailTimeout: Number(args['mail-timeout'] || 120_000),
      onState: ({ state }) => process.stderr.write(`${JSON.stringify({ status: state })}\n`),
    });
    output({ ok: result.status === 'registered', status: result.status });
  } else {
    output({
      usage: [
        'node src/cli.js probe',
        'node src/cli.js register --jt-command=/path/to/live-runtime --mail-email=... --mail-client-id=... --mail-refresh-token=... [--password=...]',
      ],
    });
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify(errorOutput(error))}\n`);
  process.exitCode = 1;
}