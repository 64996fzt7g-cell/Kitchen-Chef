// Cloudflare Pages Function : POST /api/vision
// Analyse une photo (frigo/placard, ticket de caisse ou recette) avec Claude.
// Variables à définir dans Cloudflare Pages → Settings → Variables and secrets :
//   ANTHROPIC_API_KEY (secret, obligatoire)
//   ACCESS_CODE       (secret, conseillé : code demandé par l'application)
//   MODEL             (facultatif, défaut : claude-sonnet-5-5)

const PROMPTS = {
  fridge: `Tu es un assistant d'inventaire alimentaire. Liste chaque produit alimentaire distinct visible sur cette photo (frigo, congélateur ou placard).
Règles :
- Noms courts en français courant (ex. "Lait demi-écrémé", "Yaourts nature", "Beurre doux", "Carottes").
- Quantité : compte les unités visibles. Si l'étiquette d'un emballage est lisible (500 g, 1 L…), donne ce poids ou volume. Sinon, donne un nombre d'unités ("u").
- confidence = "unsure" si le produit est partiellement caché, si l'identification est douteuse ou si la quantité est une estimation grossière.
- zone : "frigo", "congel", "sale" (épicerie salée) ou "sucre" (épicerie sucrée), d'après le contexte de la photo et le produit.
- Ignore les objets non alimentaires et les contenants vides.
Réponds UNIQUEMENT avec ce JSON, sans texte autour :
{"items":[{"name":"","quantity":1,"unit":"u|g|kg|ml|cl|L","zone":"frigo|congel|sale|sucre","confidence":"sure|unsure","note":""}]}`,

  receipt: `Tu lis un ticket de caisse français. Extrais l'enseigne et chaque produit alimentaire acheté.
Règles :
- Noms courts et lisibles en français (développe les abréviations : "LAIT DEMI ECR 1L" → "Lait demi-écrémé").
- quantity/unit : contenance réelle si elle figure (1 L, 500 g…) multipliée par le nombre d'articles ; sinon nombre d'articles en "u". Pour les produits au poids, utilise le poids indiqué en kg.
- total_price : prix total payé pour la ligne, en euros (nombre). Tient compte des remises indiquées sur la ligne suivante.
- zone : "frigo", "congel", "sale" ou "sucre".
- confidence = "unsure" si la ligne est peu lisible.
- Ignore les produits non alimentaires, les sous-totaux, la TVA, les moyens de paiement.
Réponds UNIQUEMENT avec ce JSON, sans texte autour :
{"store":"","items":[{"name":"","quantity":1,"unit":"u|g|kg|ml|cl|L","total_price":0,"zone":"frigo|congel|sale|sucre","confidence":"sure|unsure"}]}`,

  product: `Identifie le produit alimentaire principal montré au centre de l'image (tenu en main, posé, emballé ou en vrac). S'il y en a plusieurs identiques, compte-les.
- name : nom court en français courant. Si l'emballage est lisible, utilise le vrai nom du produit (ex. "Nutella", "Yaourt nature Danone", "Camembert"), sinon un nom générique ("Pommes Gala", "Courgettes").
- brand : marque si lisible, sinon "".
- quantity/unit : contenance lisible sur l'étiquette (500 g, 1 L…) ou nombre d'unités visibles en "u".
- zone : "frigo", "congel", "sale" (épicerie salée) ou "sucre" (épicerie sucrée).
- confidence = "unsure" si tu hésites.
- Si aucun produit alimentaire n'est clairement visible (pièce vide, image floue, main seule…), renvoie name "".
Réponds UNIQUEMENT avec ce JSON, sans texte autour :
{"name":"","brand":"","quantity":1,"unit":"u|g|kg|ml|cl|L","zone":"frigo|congel|sale|sucre","confidence":"sure|unsure"}`,

  recipe: `Transcris la recette visible sur cette photo (imprimée ou manuscrite), en français.
Réponds UNIQUEMENT avec ce JSON, sans texte autour :
{"name":"","time_minutes":null,"ingredients":["250 g de farine","3 œufs"],"steps":["Étape 1…","Étape 2…"]}
Les ingrédients doivent commencer par la quantité quand elle existe.`
};

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function onRequestPost({ request, env }) {
  if (!env.ANTHROPIC_API_KEY) return json({ error: "not_configured" }, 503);
  if (env.ACCESS_CODE && request.headers.get("x-access-code") !== env.ACCESS_CODE) return json({ error: "bad_code" }, 401);

  let body;
  try { body = await request.json(); } catch { return json({ error: "bad_request" }, 400); }
  const prompt = PROMPTS[body.mode];
  const image = typeof body.image === "string" ? body.image.replace(/^data:image\/\w+;base64,/, "") : "";
  if (!prompt || !image) return json({ error: "bad_request" }, 400);
  if (image.length > 6_000_000) return json({ error: "too_large" }, 413);

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": env.ANTHROPIC_API_KEY,
      "anthropic-version": "2023-06-01"
    },
    body: JSON.stringify({
      model: env.MODEL || "claude-sonnet-5-5",
      max_tokens: 2000,
      messages: [{
        role: "user",
        content: [
          { type: "image", source: { type: "base64", media_type: "image/jpeg", data: image } },
          { type: "text", text: prompt }
        ]
      }]
    })
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => "");
    return json({ error: "api_error", status: res.status, detail: detail.slice(0, 300) }, 502);
  }
  const data = await res.json();
  const text = (data.content || []).filter(b => b.type === "text").map(b => b.text).join("");
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return json({ error: "unreadable" }, 502);
  try { return json(JSON.parse(match[0])); } catch { return json({ error: "unreadable" }, 502); }
}

export async function onRequestGet({ env }) {
  return json({ configured: !!env.ANTHROPIC_API_KEY, protected: !!env.ACCESS_CODE });
}
