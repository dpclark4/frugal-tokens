function required(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

async function run(
  command: string,
  args: string[],
  environment: Record<string, string>,
) {
  const result = await new Deno.Command(command, {
    args,
    env: environment,
    stdout: "inherit",
    stderr: "inherit",
  }).output();
  if (!result.success) {
    throw new Error(`${command} ${args[0] ?? ""} failed`);
  }
}

const environment = {
  ...Deno.env.toObject(),
  VITE_API_BASE_URL: required("DEPLOY_API_BASE_URL"),
};
const project = required("DEPLOY_PAGES_PROJECT");

await run(Deno.execPath(), ["task", "build"], environment);
await run(Deno.execPath(), [
  "run",
  "-A",
  "npm:wrangler@4",
  "pages",
  "deploy",
  "dist",
  `--project-name=${project}`,
  "--branch=main",
], environment);
