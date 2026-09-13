import type { Context } from "../context.js";
import { type CheckResult, describe, fail, pass, skip } from "../result.js";
import { readPackage } from "../spkg.js";

/**
 * Checks 6 and 7: the two claims that live outside our infrastructure.
 *
 * Both depend on third-party services with their own limits and their own
 * release schedules, so an answer we cannot get is reported as skipped with
 * the reason, not as a failure — but an answer we do get that contradicts the
 * claim is a failure.
 */

export async function checkGithub(ctx: Context): Promise<CheckResult[]> {
  const pr = ctx.manifest.github;
  if (!pr) return [skip("pull request", "the manifest names no pull request")];
  const title = `${pr.repository}#${pr.pullRequest} is open`;
  const url = `${ctx.endpoints.github}/repos/${pr.repository}/pulls/${pr.pullRequest}`;

  let response: Response;
  try {
    response = await ctx.http(url, {
      headers: {
        accept: "application/vnd.github+json",
        "user-agent": "plimsoll-verify",
        "x-github-api-version": "2022-11-28",
      },
    });
  } catch (error) {
    return [skip(title, `GitHub is unreachable (${describe(error)})`)];
  }

  if (response.status === 403 || response.status === 429) {
    const remaining = response.headers.get("x-ratelimit-remaining");
    const reset = Number(response.headers.get("x-ratelimit-reset"));
    await response.body?.cancel().catch(() => {});
    if (remaining === "0" && Number.isFinite(reset)) {
      const at = new Date(reset * 1000).toISOString().slice(11, 16);
      return [skip(title, `GitHub's unauthenticated limit of 60 requests an hour is used up until ${at} UTC`)];
    }
    return [skip(title, `GitHub refused the request (HTTP ${response.status})`)];
  }
  if (response.status === 404) return [fail(title, "no such pull request")];
  if (!response.ok) return [skip(title, `GitHub returned HTTP ${response.status}`)];

  const body = (await response.json()) as {
    state?: string;
    merged_at?: string | null;
    title?: string;
    html_url?: string;
    user?: { login?: string };
    base?: { ref?: string };
    additions?: number;
    deletions?: number;
    changed_files?: number;
  };
  const facts =
    `"${body.title}" · by ${body.user?.login} into ${body.base?.ref} · ` +
    `+${body.additions}/−${body.deletions} in ${body.changed_files} files`;
  if (body.merged_at) return [pass(`${pr.repository}#${pr.pullRequest} is merged`, facts, body.html_url)];
  if (body.state === "open") return [pass(title, facts, body.html_url)];
  return [fail(title, `closed without being merged · ${facts}`, body.html_url)];
}

/**
 * The published release, read from the registry the way a stranger would.
 *
 * The package is fetched by name and version from the registry's download
 * endpoint — the same one the Substreams CLI resolves `name@version` through —
 * and its module list is read out of the package bytes. Nothing here reads the
 * local `substreams.yaml`: a claim about what is published has to stand on what
 * the registry serves, and a check that consulted our own sources would pass a
 * release that shipped without the modules those sources describe. That is not
 * hypothetical; v0.1.1 went out missing `map_positions`.
 */
export async function checkSubstreams(ctx: Context): Promise<CheckResult[]> {
  const published = ctx.manifest.substreams?.published;
  if (!published) return [skip("Substreams package", "the manifest names no published release")];

  const title = `${published.name} ${published.version} on substreams.dev`;
  const page = `${ctx.endpoints.substreams}/packages/${published.name}/${published.version}`;
  const download = `${ctx.endpoints.spkg}/v1/packages/${published.name}/${published.version}`;

  let response: Response;
  try {
    response = await ctx.http(download);
  } catch (error) {
    return [skip(title, `the registry is unreachable (${describe(error)})`)];
  }
  if (response.status === 404) {
    await response.body?.cancel().catch(() => {});
    // We are the ones asserting this release exists, so the registry saying
    // otherwise contradicts the claim rather than failing to confirm it.
    return [fail(title, "the manifest claims this release is published; the registry has no such package", page)];
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    return [skip(title, `the registry returned HTTP ${response.status} for ${download}`)];
  }

  let pkg;
  try {
    pkg = readPackage(new Uint8Array(await response.arrayBuffer()));
  } catch (error) {
    return [fail(title, `the registry served something that is not a Substreams package (${describe(error)})`, page)];
  }

  const problems: string[] = [];
  if (pkg.version !== published.version) {
    problems.push(`the package it served declares ${pkg.version ?? "no version"}`);
  }
  if (published.modules !== undefined && pkg.modules.length !== published.modules) {
    problems.push(`${pkg.modules.length} modules, expected ${published.modules}`);
  }
  const missing = (published.requires ?? []).filter((module) => !pkg.modules.includes(module));
  if (missing.length > 0) problems.push(`missing ${missing.join(", ")}`);
  if (problems.length > 0) return [fail(title, problems.join("; "), page)];

  const present = (published.requires ?? []).map((module) => ` · ${module} present`).join("");
  return [pass(title, `published · ${pkg.modules.length} modules${present}`, page)];
}
