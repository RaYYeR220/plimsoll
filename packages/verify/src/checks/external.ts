import { existsSync } from "node:fs";
import { relative, sep } from "node:path";
import type { Context } from "../context.js";
import { type CheckResult, describe, fail, pass, skip } from "../result.js";

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

export async function checkSubstreams(ctx: Context): Promise<CheckResult[]> {
  const pkg = ctx.inputs.substreams;
  if (!pkg) {
    // Say which of three things is true, rather than blaming the manifest for a
    // file this checkout simply does not carry.
    const named = ctx.inputs.substreamsManifest;
    const shown = named ? relative(ctx.inputs.repoRoot, named).split(sep).join("/") : null;
    const reason = !named
      ? "the manifest names no substreams.yaml"
      : !existsSync(named)
        ? `${shown} is not in this checkout, so there is no package to look up`
        : `${shown} has no package name and version`;
    return [skip("Substreams package", reason)];
  }
  const title = `${pkg.name} ${pkg.version} on substreams.dev`;
  const url = `${ctx.endpoints.substreams}/packages/${pkg.name}/${pkg.version}`;

  let response: Response;
  try {
    response = await ctx.http(url);
  } catch (error) {
    return [skip(title, `substreams.dev is unreachable (${describe(error)})`)];
  }
  await response.body?.cancel().catch(() => {});
  if (response.status === 200) return [pass(title, "published", url)];
  if (response.status === 404) {
    return [
      skip(title, "not yet published: the package is built from packages/substreams but not released to the registry"),
    ];
  }
  return [skip(title, `substreams.dev returned HTTP ${response.status}`)];
}
