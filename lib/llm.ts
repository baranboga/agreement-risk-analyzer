// lib/llm.ts
// -----------------------------------------------------------------------------
// SAĞLAYICIYA (OpenAI) ÖZEL HER ŞEY BU DOSYADA.
// İleride başka bir sağlayıcıya geçilecekse yalnızca burası değişir; route ve
// UI dokunulmaz. Bilerek SDK KULLANMIYORUZ (öğrenme amacı): ham fetch + elle
// SSE ayrıştırma.
//
// İki şey sağlar:
//   1) openAICagir            -> tek streaming çağrı, ham Response döner
//   2) openAIParcalariniOku   -> OpenAI'ın SSE akışını "anlamlı parçalara" çevirir
// -----------------------------------------------------------------------------

const OPENAI_URL = "https://api.openai.com/v1/chat/completions";

// --- Mesaj tipleri (OpenAI Chat Completions formatı) ------------------------

export type OpenAIToolCall = {
  id: string;
  type: "function";
  function: { name: string; arguments: string };
};

export type ChatMesaji =
  | { role: "system" | "user"; content: string }
  | { role: "assistant"; content: string | null; tool_calls?: OpenAIToolCall[] }
  | { role: "tool"; content: string; tool_call_id: string };

export type LLMParametreleri = {
  model: string;
  messages: ChatMesaji[];
  tools?: readonly unknown[];
  responseFormat?: unknown;
  signal?: AbortSignal; // Durdur butonu / client kopması buradan iptal eder
};

/**
 * OpenAI Chat Completions'a STREAMING istek atar ve ham Response döndürür.
 * Gövdeyi (SSE) okuma işi çağırana aittir (aşağıdaki openAIParcalariniOku).
 * Burada bilerek yüksek seviye "helper" yok.
 */
export async function openAICagir(p: LLMParametreleri): Promise<Response> {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    // Anahtar yoksa erken ve net hata ver.
    throw new Error("OPENAI_API_KEY tanımlı değil (.env dosyasına ekleyin).");
  }

  const body: Record<string, unknown> = {
    model: p.model,
    messages: p.messages,
    stream: true,
    // Akışın SON parçasında token usage'ı da gelsin (yoksa hiç gelmez):
    stream_options: { include_usage: true },
  };
  if (p.tools) body.tools = p.tools;
  if (p.responseFormat) body.response_format = p.responseFormat;

  // signal'i fetch'e veriyoruz -> iptal edilince upstream OpenAI isteği de
  // GERÇEKTEN abort olur (server tarafında bağlantı kapanır).
  return fetch(OPENAI_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
    signal: p.signal,
  });
}

// --- Akış (SSE) ayrıştırma ---------------------------------------------------

// openAIParcalariniOku'nun ürettiği "anlamlı parça" tipleri. Route bunları
// tüketir; OpenAI'ın ham chunk formatını route'un görmesine gerek kalmaz.
export type AkisParcasi =
  | { tip: "icerik"; delta: string } // content parçası
  | {
      tip: "tool_delta"; // tool_call parçası (parça parça gelir!)
      index: number;
      id?: string;
      isim?: string;
      argsDelta?: string;
    }
  | { tip: "bitis"; sebep: string } // finish_reason
  | { tip: "kullanim"; promptToken: number; completionToken: number };

/**
 * OpenAI'ın SSE gövdesini okur ve AkisParcasi üretir (async generator).
 *
 * OpenAI SSE formatı: her olay "data: {json}\n\n" satırıdır; son olay
 * "data: [DONE]"dır. Bir chunk içinde:
 *   - choices[0].delta.content        -> içerik parçası
 *   - choices[0].delta.tool_calls[]   -> tool çağrısı parçaları (id/isim/args
 *                                        AYRI chunk'larda parça parça gelir,
 *                                        index'e göre birleştirilir)
 *   - choices[0].finish_reason        -> "stop" | "tool_calls" | ...
 *   - usage                           -> yalnızca en son chunk'ta (choices boş)
 */
export async function* openAIParcalariniOku(
  res: Response
): AsyncGenerator<AkisParcasi> {
  if (!res.body) throw new Error("OpenAI yanıtında gövde (stream) yok.");

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let tampon = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    tampon += decoder.decode(value, { stream: true });

    // SSE olayları çift satır sonu (\n\n) ile ayrılır.
    let sinir: number;
    while ((sinir = tampon.indexOf("\n\n")) !== -1) {
      const blok = tampon.slice(0, sinir);
      tampon = tampon.slice(sinir + 2);

      // Blok birden fazla satır olabilir; "data:" ile başlayanı al.
      const satir = blok.split("\n").find((s) => s.startsWith("data:"));
      if (!satir) continue;

      const veri = satir.slice(5).trim();
      if (veri === "[DONE]") return;

      const j = JSON.parse(veri);

      // usage yalnızca en son chunk'ta gelir; o chunk'ta choices genelde boştur.
      if (j.usage) {
        yield {
          tip: "kullanim",
          promptToken: j.usage.prompt_tokens ?? 0,
          completionToken: j.usage.completion_tokens ?? 0,
        };
      }

      const secim = j.choices?.[0];
      if (!secim) continue;

      const delta = secim.delta ?? {};

      if (typeof delta.content === "string" && delta.content.length > 0) {
        yield { tip: "icerik", delta: delta.content };
      }

      if (Array.isArray(delta.tool_calls)) {
        for (const tc of delta.tool_calls) {
          yield {
            tip: "tool_delta",
            index: tc.index,
            id: tc.id,
            isim: tc.function?.name,
            argsDelta: tc.function?.arguments,
          };
        }
      }

      if (secim.finish_reason) {
        yield { tip: "bitis", sebep: secim.finish_reason };
      }
    }
  }
}
