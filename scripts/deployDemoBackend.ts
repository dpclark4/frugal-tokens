import { spawn } from "node:child_process";
import { once } from "node:events";
import process from "node:process";
function required(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
}

const service = required("DEPLOY_RAILWAY_SERVICE");
const child = spawn("railway", [
  "up",
  "--service",
  service,
  "--environment",
  "production",
  "--ci",
  "-m",
  "Deploy demo API",
], { stdio: ["ignore", "inherit", "inherit"] });
const [code] = await once(child, "close");

if (code !== 0) {
  throw new Error("railway up failed");
}
