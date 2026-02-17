/**
 * ADAS API client — thin HTTP wrapper for the External Agent API.
 */

const BASE_URL = process.env.ADAS_API_URL || "https://api.ateam-ai.com";
const TENANT = process.env.ADAS_TENANT || "main";
const API_KEY = process.env.ADAS_API_KEY || "";

function headers() {
  return {
    "Content-Type": "application/json",
    "X-ADAS-TENANT": TENANT,
    "X-API-KEY": API_KEY,
  };
}

export async function get(path) {
  const res = await fetch(`${BASE_URL}${path}`, { headers: headers() });
  if (!res.ok) throw new Error(`GET ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function post(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "POST",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`POST ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function patch(path, body) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "PATCH",
    headers: headers(),
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`PATCH ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}

export async function del(path) {
  const res = await fetch(`${BASE_URL}${path}`, {
    method: "DELETE",
    headers: headers(),
  });
  if (!res.ok) throw new Error(`DELETE ${path} → ${res.status}: ${await res.text()}`);
  return res.json();
}
