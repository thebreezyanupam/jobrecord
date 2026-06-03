function stripWrappers(text) {
  let s = text.replace(/^\uFEFF/, '').trim();
  const fence = s.match(/^```(?:json)?\s*([\s\S]*?)```$/i);
  if (fence) s = fence[1].trim();
  return s;
}

function normalizeJsonText(text) {
  let s = stripWrappers(text);
  s = s.replace(/[\u201C\u201D]/g, '"').replace(/[\u2018\u2019]/g, "'");
  s = s.replace(/,(\s*[}\]])/g, '$1');
  return s;
}

export function parseJobsFromJson(text, validStatuses) {
  const normalized = normalizeJsonText(text);
  if (!normalized) {
    throw new Error('Paste a job JSON object or array of objects.');
  }

  let parsed;
  try {
    parsed = JSON.parse(normalized);
  } catch {
    throw new Error('Invalid JSON. Use double quotes, no trailing commas, and valid brackets.');
  }

  const items = Array.isArray(parsed) ? parsed : [parsed];
  if (!items.length) {
    throw new Error('Paste a job object or an array of job objects.');
  }

  const baseId = Date.now();

  return items.map((raw, i) => {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`Entry ${i + 1} must be a JSON object.`);
    }

    const company = String(raw.company ?? '').trim();
    const role = String(raw.role ?? '').trim();
    if (!company || !role) {
      throw new Error(`Entry ${i + 1}: "company" and "role" are required.`);
    }

    const status = validStatuses.has(raw.status) ? raw.status : 'applied';

    return {
      company,
      role,
      location: String(raw.location ?? ''),
      jobUrl: String(raw.jobUrl ?? ''),
      appliedDate: String(raw.appliedDate ?? ''),
      status,
      chanceBase: raw.chanceBase != null ? String(raw.chanceBase) : '',
      chanceCustomized: raw.chanceCustomized != null ? String(raw.chanceCustomized) : '',
      platform: String(raw.platform ?? ''),
      notes: String(raw.notes ?? ''),
      resumeVersion: String(raw.resumeVersion ?? ''),
      coverLetter: Boolean(raw.coverLetter),
      id: raw.id != null && raw.id !== '' ? Number(raw.id) : baseId + i,
    };
  });
}
