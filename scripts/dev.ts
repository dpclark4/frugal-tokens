const usage = "Usage: deno task dev [web-port]";
const suppliedPort = Deno.args[0];

if (Deno.args.length > 1 || (suppliedPort !== undefined && !/^\d+$/.test(suppliedPort))) {
  console.error(usage);
  Deno.exit(1);
}

const webPort = suppliedPort === undefined ? 5273 : Number(suppliedPort);
const apiPort = webPort + (9000 - 5273);

if (!Number.isInteger(webPort) || webPort < 1024 || apiPort > 65535) {
  console.error("Web port must be between 1024 and 61808.");
  Deno.exit(1);
}

console.log(`Starting web: http://localhost:${webPort}`);
console.log(`Starting API: http://localhost:${apiPort}`);

const child = new Deno.Command(Deno.execPath(), {
  args: [
    "run",
    "-A",
    "npm:concurrently@10.0.3",
    "--kill-others-on-fail",
    "--names",
    "api,web",
    "deno task dev:server",
    "deno task dev:client",
  ],
  env: {
    FRUGAL_TOKENS_WEB_PORT: String(webPort),
    FRUGAL_TOKENS_API_PORT: String(apiPort),
    PORT: String(apiPort),
  },
  stdin: "inherit",
  stdout: "inherit",
  stderr: "inherit",
}).spawn();

const status = await child.status;
Deno.exit(status.code);
