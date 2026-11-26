// Função do Vercel: busca profissionais reais perto do usuário no Google Maps (Google Places API).
// A localização vem do IP do visitante, pelos cabeçalhos que o próprio Vercel adiciona
// (x-vercel-ip-latitude / longitude / city). Nenhum serviço extra de geolocalização é usado.
// Precisa da variável de ambiente GOOGLE_PLACES_API_KEY no Vercel.

const MAX_RESULTS = 10;
const MIN_REVIEWS = 5;      // com menos avaliações que isso, a nota vai para o fim da lista
const RADIUS_M = 25000;     // raio de busca: 25 km em volta da localização aproximada
const PER_HOUR = 30;        // buscas por pessoa (IP) por hora

const hits = new Map();
function tooMany(ip) {
  const now = Date.now(), hour = 3600_000;
  const list = (hits.get(ip) || []).filter(t => now - t < hour);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 5000) hits.clear();
  return list.length > PER_HOUR;
}

function km(a, b) {
  const R = 6371, rad = x => x * Math.PI / 180;
  const dLat = rad(b.latitude - a.latitude), dLng = rad(b.longitude - a.longitude);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(rad(a.latitude)) * Math.cos(rad(b.latitude)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

module.exports = async (req, res) => {
  res.setHeader('Cache-Control', 'private, no-store');
  const key = process.env.GOOGLE_PLACES_API_KEY;
  if (!key) {
    console.error('[profissionais] GOOGLE_PLACES_API_KEY não está definida neste deploy');
    return res.status(503).json({ error: 'not_configured' });
  }

  const ip = String(req.headers['x-forwarded-for'] || '').split(',')[0].trim() || 'unknown';
  if (tooMany(ip)) return res.status(429).json({ error: 'rate_limited' });

  const q = String(req.query.q || '').slice(0, 60).trim();
  const lang = req.query.lang === 'en' ? 'en' : 'pt-BR';
  if (!q) return res.status(400).json({ error: 'bad_request' });

  const lat = parseFloat(req.headers['x-vercel-ip-latitude']);
  const lng = parseFloat(req.headers['x-vercel-ip-longitude']);
  const city = decodeURIComponent(String(req.headers['x-vercel-ip-city'] || ''));
  const region = String(req.headers['x-vercel-ip-country-region'] || '');
  const hasLoc = isFinite(lat) && isFinite(lng);
  const center = hasLoc ? { latitude: lat, longitude: lng } : null;

  const body = {
    textQuery: city ? `${q} ${lang === 'en' ? 'in' : 'em'} ${city}` : q,
    languageCode: lang,
    pageSize: 20
  };
  if (center) body.locationBias = { circle: { center, radius: RADIUS_M } };

  try {
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': key,
        'X-Goog-FieldMask': 'places.displayName,places.rating,places.userRatingCount,places.nationalPhoneNumber,places.internationalPhoneNumber,places.formattedAddress,places.googleMapsUri,places.location,places.businessStatus'
      },
      body: JSON.stringify(body)
    });
    const data = await r.json();
    if (!r.ok) {
      console.error('[profissionais] Google respondeu', r.status, JSON.stringify(data && data.error));
      return res.status(502).json({ error: 'upstream' });
    }

    const list = (data.places || [])
      .filter(p => p.businessStatus !== 'CLOSED_PERMANENTLY' && p.displayName)
      .map(p => ({
        name: p.displayName.text,
        rating: p.rating || 0,
        reviews: p.userRatingCount || 0,
        phone: p.nationalPhoneNumber || p.internationalPhoneNumber || '',
        tel: (p.internationalPhoneNumber || p.nationalPhoneNumber || '').replace(/[^\d+]/g, ''),
        address: p.formattedAddress || '',
        maps: p.googleMapsUri || '',
        km: center && p.location ? Math.round(km(center, p.location) * 10) / 10 : null
      }))
      // Ordem: nota no Google (maior primeiro); empate → mais avaliações.
      // Quem tem menos de MIN_REVIEWS avaliações vai para o fim, para um 5,0 com 1 avaliação não passar na frente.
      .sort((a, b) =>
        ((b.reviews >= MIN_REVIEWS) - (a.reviews >= MIN_REVIEWS)) ||
        (b.rating - a.rating) ||
        (b.reviews - a.reviews))
      .slice(0, MAX_RESULTS);

    return res.status(200).json({ city: city ? (region ? `${city}, ${region}` : city) : '', located: hasLoc, list });
  } catch (e) {
    console.error('[profissionais] falha ao chamar o Google:', e && e.message);
    return res.status(502).json({ error: 'upstream_failed' });
  }
};
