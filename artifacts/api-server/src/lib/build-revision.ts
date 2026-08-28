declare const __TOPMART_BUILD_COMMIT__: string;
declare const __TOPMART_SOURCE_SHA256__: string;

const SHA256_RE = /^[a-f0-9]{64}$/;

function definedBuildValue(name: "commit" | "sourceSha256"): string | undefined {
  if (name === "commit" && typeof __TOPMART_BUILD_COMMIT__ === "string") {
    return __TOPMART_BUILD_COMMIT__;
  }
  if (
    name === "sourceSha256"
    && typeof __TOPMART_SOURCE_SHA256__ === "string"
  ) {
    return __TOPMART_SOURCE_SHA256__;
  }
  return undefined;
}

export function getBuildRevision(): {
  commit: string;
  sourceSha256: string;
} {
  const compiledCommit = definedBuildValue("commit")?.trim();
  const commit = (
    compiledCommit && compiledCommit.toLowerCase() !== "unknown"
      ? compiledCommit
      : undefined
  ) ?? (
    process.env.RAILWAY_GIT_COMMIT_SHA
    ?? process.env.TOPMART_BUILD_COMMIT
    ?? "unknown"
  );
  const sourceSha256 = (
    definedBuildValue("sourceSha256")
    ?? process.env.TOPMART_SOURCE_SHA256
    ?? "unknown"
  ).trim().toLowerCase();

  return {
    commit: commit.trim() || "unknown",
    sourceSha256: SHA256_RE.test(sourceSha256) ? sourceSha256 : "unknown",
  };
}