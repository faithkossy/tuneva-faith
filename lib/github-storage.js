

const API = "https://api.github.com";

const SETTINGS_FILE = "data/admin-settings.json";
const SETTINGS_CACHE_TTL = 10000;

const readCache = new Map();
const pendingReads = new Map();

function getConfig() {
  const owner = process.env.GITHUB_OWNER;
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  const branch = process.env.GITHUB_BRANCH || "main";

  if (!owner || !repo || !token) {
    throw new Error("GitHub storage environment variables are missing.");
  }

  return { owner, repo, token, branch };
}

function getHeaders(token, accept = "application/vnd.github+json") {
  return {
    Authorization: `Bearer ${token}`,
    Accept: accept,
    "X-GitHub-Api-Version": "2022-11-28"
  };
}

function getFileURL(owner, repo, path) {
  const safePath = path
    .split("/")
    .map(encodeURIComponent)
    .join("/");

  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/contents/${safePath}`;
}

function getBlobURL(owner, repo, sha) {
  return `${API}/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/git/blobs/${encodeURIComponent(sha)}`;
}

function cloneData(data) {
  return JSON.parse(JSON.stringify(data));
}

function decodeBase64(content, path) {
  if (typeof content !== "string" || !content.trim()) {
    throw new Error(`GitHub returned empty file content: ${path}`);
  }

  try {
    return Buffer.from(
      content.replace(/\s/g, ""),
      "base64"
    ).toString("utf8");
  } catch (_) {
    throw new Error(`Could not decode GitHub file content: ${path}`);
  }
}

function parseJSONContent(content, path) {
  try {
    return JSON.parse(content);
  } catch (_) {
    throw new Error(`Invalid JSON stored in ${path}`);
  }
}

/*
 * Retrieve large GitHub blobs as raw content.
 * This avoids depending on the Base64 content field.
 */

async function fetchBlobContent(owner, repo, token, sha, path) {
  const response = await fetch(
    getBlobURL(owner, repo, sha),
    {
      headers: getHeaders(
        token,
        "application/vnd.github.raw+json"
      )
    }
  );

  if (!response.ok) {
    throw new Error(
      `GitHub raw blob read failed (${response.status}): ${await response.text()}`
    );
  }

  const content = await response.text();

  if (!content.trim()) {
    throw new Error(
      `GitHub returned empty raw blob content: ${path}`
    );
  }

  return content;
}

async function fetchJSON(path, fallback) {
  const { owner, repo, token, branch } = getConfig();

  const url =
    `${getFileURL(owner, repo, path)}?ref=${encodeURIComponent(branch)}`;

  /*
   * Object format provides file metadata and SHA
   * for large files without requiring inline content.
   */

  const response = await fetch(url, {
    headers: getHeaders(
      token,
      "application/vnd.github.object+json"
    )
  });

  if (response.status === 404) {
    return {
      data: fallback,
      sha: null
    };
  }

  if (!response.ok) {
    throw new Error(
      `GitHub read failed (${response.status}): ${await response.text()}`
    );
  }

  const file = await response.json();

  if (!file.sha) {
    throw new Error(
      `GitHub did not return a file SHA: ${path}`
    );
  }

  if (typeof file.size === "number" && file.size > 100 * 1024 * 1024) {
    throw new Error(
      `GitHub cannot retrieve ${path}: file exceeds the 100 MB API limit.`
    );
  }

  let decoded;

  if (
    typeof file.content === "string" &&
    file.content.trim() &&
    file.encoding === "base64"
  ) {
    decoded = decodeBase64(file.content, path);

  } else {
    decoded = await fetchBlobContent(
      owner,
      repo,
      token,
      file.sha,
      path
    );
  }

  const data = parseJSONContent(decoded, path);

  return {
    data,
    sha: file.sha
  };
}

async function readJSON(path, fallback = {}) {
  const now = Date.now();

  if (path === SETTINGS_FILE) {
    const cached = readCache.get(path);

    if (cached && now < cached.expiresAt) {
      return {
        data: cloneData(cached.data),
        sha: cached.sha
      };
    }
  }

  if (pendingReads.has(path)) {
    const result = await pendingReads.get(path);

    return {
      data: cloneData(result.data),
      sha: result.sha
    };
  }

  const request = fetchJSON(path, fallback);

  pendingReads.set(path, request);

  try {
    const result = await request;

    if (path === SETTINGS_FILE) {
      readCache.set(path, {
        data: cloneData(result.data),
        sha: result.sha,
        expiresAt: Date.now() + SETTINGS_CACHE_TTL
      });
    }

    return {
      data: cloneData(result.data),
      sha: result.sha
    };

  } finally {
    pendingReads.delete(path);
  }
}

async function writeJSON(path, data, existingSHA = null) {
  const { owner, repo, token, branch } = getConfig();

  const url = getFileURL(owner, repo, path);
  const headers = getHeaders(token);

  let sha = existingSHA;

  if (!sha) {
    const lookup = await fetch(
      `${url}?ref=${encodeURIComponent(branch)}`,
      { headers }
    );

    if (lookup.ok) {
      const existing = await lookup.json();
      sha = existing.sha;

    } else if (lookup.status !== 404) {
      throw new Error(
        `GitHub file lookup failed (${lookup.status}): ${await lookup.text()}`
      );
    }
  }

  const content = Buffer.from(
    JSON.stringify(data, null, 2),
    "utf8"
  ).toString("base64");

  const payload = {
    message: `Update ${path}`,
    content,
    branch
  };

  if (sha) {
    payload.sha = sha;
  }

  const response = await fetch(url, {
    method: "PUT",

    headers: {
      ...headers,
      "Content-Type": "application/json"
    },

    body: JSON.stringify(payload)
  });

  if (!response.ok) {
    throw new Error(
      `GitHub write failed (${response.status}): ${await response.text()}`
    );
  }

  const result = await response.json();

  const saved = {
    data,
    sha: result.content?.sha || null
  };

  if (path === SETTINGS_FILE) {
    readCache.set(path, {
      data: cloneData(data),
      sha: saved.sha,
      expiresAt: Date.now() + SETTINGS_CACHE_TTL
    });
  }

  pendingReads.delete(path);

  if (path !== SETTINGS_FILE) {
    readCache.delete(path);
  }

  return saved;
}

module.exports = {
  readJSON,
  writeJSON
};
