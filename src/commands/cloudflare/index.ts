import { Command } from "commander";
import { token } from "./token";

export const cloudflare = new Command("cloudflare")
  .description("Cloudflare account setup that has no API and has to go through the dashboard");

[token].forEach((cmd) => { cloudflare.addCommand(cmd); });
