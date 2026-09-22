import { homedir } from "node:os";
import { join, resolve } from "node:path";

// A separate directory also isolates daemons started with different credentials.
export const JB_DIR = process.env.JB_RUNTIME_DIR?.trim()
	? resolve(process.env.JB_RUNTIME_DIR)
	: join(homedir(), ".jb");
export const SOCK_PATH = join(JB_DIR, "jb.sock");
export const PID_PATH = join(JB_DIR, "jb.pid");
export const LOCK_PATH = join(JB_DIR, "jb.lock");
