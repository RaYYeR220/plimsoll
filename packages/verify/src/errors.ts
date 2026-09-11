import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { decodeErrorResult, parseAbiItem, type Abi, type Hex } from "viem";
import { short } from "./result.js";

/**
 * Custom errors, read from the contracts' own Solidity at run time.
 *
 * A hardcoded error table would be the one place in this package that could
 * silently disagree with the deployed code after a redeploy. Parsing the
 * `error` declarations out of the committed sources keeps the names honest:
 * rename an error, and the verifier decodes the new name.
 *
 * Declarations that use user-defined types (an enum, a struct) cannot be turned
 * into an ABI without those definitions and are left out. That can only cost a
 * revert its name in the output; the bytes are still compared exactly.
 */
export interface DecodedRevert {
  name: string;
  args: readonly unknown[];
}

export function loadErrorAbi(sourceDir: string): Abi {
  const items: unknown[] = [];
  const seen = new Set<string>();
  const visit = (path: string) => {
    if (!existsSync(path)) return;
    if (statSync(path).isDirectory()) {
      for (const entry of readdirSync(path)) visit(join(path, entry));
      return;
    }
    if (!path.endsWith(".sol")) return;
    const text = readFileSync(path, "utf8");
    for (const match of text.matchAll(/\berror\s+(\w+)\s*\(([^)]*)\)\s*;/g)) {
      const declaration = `error ${match[1]}(${match[2]!.replace(/\s+/g, " ").trim()})`;
      if (seen.has(declaration)) continue;
      seen.add(declaration);
      try {
        items.push(parseAbiItem(declaration));
      } catch {
        // A user-defined type in the signature; see the note above.
      }
    }
  };
  visit(sourceDir);
  return items as Abi;
}

export function decodeRevert(abi: Abi, data: string | null | undefined): DecodedRevert | null {
  if (!data || data.length < 10) return null;
  try {
    const decoded = decodeErrorResult({ abi, data: data as Hex });
    return { name: decoded.errorName, args: (decoded.args ?? []) as readonly unknown[] };
  } catch {
    return null;
  }
}

export function formatRevert(revert: DecodedRevert): string {
  const show = (value: unknown): string => {
    if (typeof value === "bigint" || typeof value === "number") return String(value);
    if (typeof value === "string") return value.startsWith("0x") ? short(value) : JSON.stringify(value);
    return String(value);
  };
  return `${revert.name}(${revert.args.map(show).join(", ")})`;
}

/** The mirror node reports "no revert" as null, "" or "0x" depending on the path. */
export function normaliseRevertData(data: string | null | undefined): string {
  const hex = (data ?? "").toLowerCase();
  return hex === "" || hex === "0x" ? "0x" : hex;
}
