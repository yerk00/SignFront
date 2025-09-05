import axios from "axios";

export function getBaseURL() {
  return (import.meta.env.VITE_API_BASE_URL || "http://127.0.0.1:8000").replace(/\/+$/,"");
}

export async function predictSignature(file, { threshold, tta, baseURL } = {}) {
  const urlBase = (baseURL || getBaseURL()).replace(/\/+$/,"");
  const form = new FormData();
  form.append("file", file, file.name);

  const { data } = await axios.post(`${urlBase}/predict`, form, {
    params: {
      ...(threshold !== undefined ? { threshold } : {}),
      ...(tta !== undefined ? { tta } : {})
    },
    headers: { "Content-Type": "multipart/form-data" }
  });
  return data;
}
