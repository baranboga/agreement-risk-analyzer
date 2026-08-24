// app/api/experiment/route.ts
// -----------------------------------------------------------------------------
// POST /api/experiment  — DENEY MODU (tek tarama)
//   Girdi : { metin: string, model?: string, kosul: "A" | "B" | "C" }
//   Çıktı : JSON (DeneySonucu)  — SSE YOK; tam cevap beklenir.
//
// Normal /api/analyze akışına, tool döngüsüne ve maliyet hesabına DOKUNMAZ.
// Burası ayrı bir yoldur:
//   - koşula göre tool tarifi + system prompt kurulur (lib/deney.ts)
//   - NON-STREAMING çağrı yapılır (openAICagirTekParca)
//   - elle tool döngüsü döner (max 3 tur) ve ölçümler toplanır:
//       kaç tool çağrısı, gönderilen baslangicTarihi'ler, bulgu sayısı,
//       prompt/completion token, USD maliyet
//
// GÜVENLİK: OPENAI_API_KEY yalnızca sunucuda okunur (lib/llm.ts içinde).
// -----------------------------------------------------------------------------

import {
  openAICagirTekParca,
  type ChatMesaji,
  type OpenAIToolCall,
} from "@/lib/llm";
import { analizJsonSchema } from "@/lib/schema";
import { toolCalistir } from "@/lib/tools";
import {
  deneyToollariniKur,
  deneySistemPromptu,
  type DeneyKosulu,
  type DeneySonucu,
} from "@/lib/deney";
import { maliyetHesapla, FIYATLAR, type ModelAdi } from "@/lib/cost";

export const runtime = "nodejs";

const VARSAYILAN_MODEL: ModelAdi = "gpt-4.1";
const MAKS_TUR = 3; // tool döngüsü en fazla bu kadar tur döner

// JSON.parse'ı patlatmadan deneyen küçük yardımcı.
function guvenliParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

function gecerliKosul(x: unknown): x is DeneyKosulu {
  return x === "A" || x === "B" || x === "C";
}

export async function POST(req: Request) {
  const govde = await req.json().catch(() => null);
  const metin: string = typeof govde?.metin === "string" ? govde.metin : "";
  // Model yalnızca bilinen modellerden olabilir (güvenlik + fiyat tablosu).
  const istenenModel: string = typeof govde?.model === "string" ? govde.model : "";
  const model: ModelAdi =
    istenenModel in FIYATLAR ? (istenenModel as ModelAdi) : VARSAYILAN_MODEL;
  const kosul: DeneyKosulu = gecerliKosul(govde?.kosul) ? govde.kosul : "A";

  if (!metin.trim()) {
    return Response.json({ hata: "Sözleşme metni boş." }, { status: 400 });
  }

  // "bugünü varsay" dürtüsü için referans tarih (üç koşulda da ortak).
  const bugun = new Date().toISOString().slice(0, 10);

  // Koşula göre tool tarifi ve system prompt — TEK değişken bu.
  const tools = deneyToollariniKur(kosul);
  const messages: ChatMesaji[] = [
    { role: "system", content: deneySistemPromptu(kosul, bugun) },
    { role: "user", content: metin },
  ];

  // Turlar arasında biriken ölçümler.
  let toplamPrompt = 0;
  let toplamCompletion = 0;
  let toolCagriSayisi = 0;
  const baslangicTarihleri: string[] = [];
  let bulguSayisi = 0;

  try {
    // ==================== ELLE TOOL DÖNGÜSÜ (max 3 tur, NON-STREAMING) =========
    let tur = 0;
    while (tur < MAKS_TUR) {
      tur++;

      const res = await openAICagirTekParca({
        model,
        messages,
        tools,
        responseFormat: { type: "json_schema", json_schema: analizJsonSchema() },
        signal: req.signal,
      });

      if (!res.ok) {
        const hataMetni = await res.text().catch(() => "");
        const mesaj =
          res.status === 429
            ? "OpenAI hız sınırına takıldı (429). Biraz bekleyip tekrar deneyin."
            : `OpenAI hatası ${res.status}: ${hataMetni.slice(0, 300)}`;
        return Response.json({ hata: mesaj }, { status: res.status });
      }

      const j = await res.json();
      toplamPrompt += j.usage?.prompt_tokens ?? 0;
      toplamCompletion += j.usage?.completion_tokens ?? 0;

      const secim = j.choices?.[0];
      const msg = secim?.message;
      const bitisSebebi: string = secim?.finish_reason ?? "";

      // ----- Model tool mu istiyor, yoksa nihai cevap mı verdi? -----
      if (bitisSebebi === "tool_calls" && Array.isArray(msg?.tool_calls)) {
        // Asistanın tool_calls mesajını geçmişe ekle (sonraki turda eşleştirme
        // için gerekir). Sadece gereken alanları taşı.
        const asistanToolCalls: OpenAIToolCall[] = msg.tool_calls.map(
          (c: OpenAIToolCall) => ({
            id: c.id,
            type: "function",
            function: { name: c.function.name, arguments: c.function.arguments },
          })
        );
        messages.push({
          role: "assistant",
          content: typeof msg.content === "string" ? msg.content : null,
          tool_calls: asistanToolCalls,
        });

        // Her tool'u çalıştır, ölç ve sonucu geçmişe ekle.
        for (const c of asistanToolCalls) {
          toolCagriSayisi++;
          const args = guvenliParse(c.function.arguments || "{}");
          if (c.function.name === "sureHesapla") {
            const bt = (args as { baslangicTarihi?: unknown })?.baslangicTarihi;
            if (typeof bt === "string") baslangicTarihleri.push(bt);
          }
          let sonucStr: string;
          try {
            sonucStr = toolCalistir(c.function.name, args);
          } catch (e) {
            // Tool hatasını modele geri ver ki düzeltip devam edebilsin.
            sonucStr = JSON.stringify({ hata: (e as Error).message });
          }
          messages.push({ role: "tool", tool_call_id: c.id, content: sonucStr });
        }

        continue; // modeli tool sonuçlarıyla tekrar çağır
      }

      // ----- finish_reason "stop": nihai JSON hazır. Bulgu sayısını çıkar. -----
      const icerik: string = typeof msg?.content === "string" ? msg.content : "";
      try {
        const obj = JSON.parse(icerik);
        bulguSayisi = Array.isArray(obj?.maddeler) ? obj.maddeler.length : 0;
      } catch {
        bulguSayisi = 0;
      }

      const usd = maliyetHesapla(model, toplamPrompt, toplamCompletion);
      const sonuc: DeneySonucu = {
        toolCagriSayisi,
        baslangicTarihleri,
        bulguSayisi,
        promptToken: toplamPrompt,
        completionToken: toplamCompletion,
        usd,
      };
      return Response.json(sonuc);
    }

    // 3 tur doldu ama model hâlâ tool istiyordu.
    return Response.json(
      { hata: `Maksimum ${MAKS_TUR} tool turu doldu; sonuç alınamadı.` },
      { status: 500 }
    );
  } catch (e) {
    if ((e as Error)?.name === "AbortError") {
      return Response.json({ hata: "İstek iptal edildi." }, { status: 499 });
    }
    return Response.json(
      { hata: (e as Error)?.message ?? "Bilinmeyen sunucu hatası." },
      { status: 500 }
    );
  }
}
