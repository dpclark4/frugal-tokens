function required(name: string) {
  const value = Deno.env.get(name);
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const service = required("DEPLOY_RAILWAY_SERVICE");
const result = await new Deno.Command("railway", {
  args: [
    "up",
    "--service",
    service,
    "--environment",
    "production",
    "--ci",
    "-m",
    "Deploy demo API",
  ],
  stdout: "inherit",
  stderr: "inherit",
}).output();

if (!result.success) {
  throw new Error("railway up failed");
}
