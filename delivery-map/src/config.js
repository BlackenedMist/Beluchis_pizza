// Load delivery zones configuration.
// In production this would be fetched from the server endpoint.
// For now we ship a sample JSON and treat it as the "server" response.

/**
 * Fetch and return the zones configuration JSON.
 * @param {string} [url='./data/sample-zones.json']
 * @returns {Promise<object>}
 */
export async function loadZones(url = './data/sample-zones.json') {
  const res = await fetch(url);
  if (!res.ok) throw new Error('Failed to load zones: ' + res.status);
  return res.json();
}
