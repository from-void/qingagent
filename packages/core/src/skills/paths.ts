import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const CORE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

export const BUILTIN_SKILLS_DIR = process.env.QINGAGENT_SKILLS_DIR
  ? isAbsolute(process.env.QINGAGENT_SKILLS_DIR)
    ? process.env.QINGAGENT_SKILLS_DIR
    : resolve(process.cwd(), process.env.QINGAGENT_SKILLS_DIR)
  : resolve(CORE_ROOT, "skills");

export const USER_SKILLS_DIR = process.env.QINGAGENT_USER_SKILLS_DIR
  ? isAbsolute(process.env.QINGAGENT_USER_SKILLS_DIR)
    ? process.env.QINGAGENT_USER_SKILLS_DIR
    : resolve(process.cwd(), process.env.QINGAGENT_USER_SKILLS_DIR)
  : resolve(homedir(), ".qingagent", "skills");

export const SKILLS_INSTALL_DIR = USER_SKILLS_DIR;
