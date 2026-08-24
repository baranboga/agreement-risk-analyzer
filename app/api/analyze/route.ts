// app/api/analyze/route.ts
// -----------------------------------------------------------------------------
// POST /api/analyze
//   Girdi : { metin: string, model?: string }
//   Çıktı : SSE akışı (text/event-stream) -> lib/protocol.ts'teki SunucuOlayi
//
// Sorumlulukları:
//   - OpenAI'a STREAMING istek atmak (lib/llm.ts üzerinden)
//   - Tool çağrı döngüsünü ELLE yürütmek (max 3 tur)
//   - İçerik parçalarını client'a SSE olarak aktarmak
//   - Token/maliyet hesaplayıp sonda göndermek
//   - Hataları üç kategoride ayrıştırıp bildirmek
//   - İstek iptalinde (Durdur) upstream fetch'i abort etmek
//
// GÜVENLİK: OPENAI_API_KEY yalnızca burada (sunucuda) okunur. Client'a asla
// gitmez; ismi NEXT_PUBLIC_ değildir.
// -----------------------------------------------------------------------------

import {
  openAICagir,
  openAIParcalariniOku,
  type ChatMesaji,
  type OpenAIToolCall,
} from "@/lib/llm";
import { analizJsonSchema } from "@/lib/schema";
import { sistemPromptu } from "@/lib/prompt";
import { toolTanimlari, toolCalistir } from "@/lib/tools";
import { maliyetHesapla, FIYATLAR, type ModelAdi } from "@/lib/cost";
import type { SunucuOlayi } from "@/lib/protocol";

// fetch'e AbortSignal geçebilmek ve process.env okumak için Node runtime.
export const runtime = "nodejs";

const VARSAYILAN_MODEL: ModelAdi = "gpt-4.1";
const MAKS_TUR = 3; // tool döngüsü en fazla bu kadar tur döner

// JSON.parse'ı patlatmadan deneyen küçük yardımcı (tool argümanlarını
// UI'da göstermek için ham string yerine nesne verelim).
function guvenliParse(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export async function POST(req: Request) {
  const govde = await req.json().catch(() => null);
  const metin: string = typeof govde?.metin === "string" ? govde.metin : "";
  // Model client'tan gelir ama SADECE bilinen modellere izin ver (güvenlik +
  // fiyat tablosunda karşılığı olsun).
  const istenenModel: string = typeof govde?.model === "string" ? govde.model : "";
  const model: ModelAdi = istenenModel in FIYATLAR ? (istenenModel as ModelAdi) : VARSAYILAN_MODEL;

  // Modelin süre hesabında referans alması için bugünün tarihi.
  const bugun = new Date().toISOString().slice(0, 10);

  // Sistem promptu TEK KAYNAKTAN gelir (lib/prompt.ts); deney A/B ile birebir
  // aynıdır. Kısıt yalnızca deney "C" koşulunda eklenir, normal akışta yok.
  const SISTEM_PROMPTU = sistemPromptu(bugun);

  const encoder = new TextEncoder();

  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      // Tek satır SSE olayı yazan yardımcı.
      const yaz = (olay: SunucuOlayi) => {
        controller.enqueue(encoder.encode(`data: ${JSON.stringify(olay)}\n\n`));
      };
      const kapat = () => {
        try {
          controller.close();
        } catch {
          /* zaten kapalıysa yut */
        }
      };

      // Boş metin erken kontrolü.
      if (!metin.trim()) {
        yaz({ tip: "hata", kind: "bilinmeyen", mesaj: "Sözleşme metni boş." });
        yaz({ tip: "bitti" });
        kapat();
        return;
      }

      // Turlar arasında biriken toplam sayaçlar.
      let toplamPrompt = 0;
      let toplamCompletion = 0;
      let toolTuru = 0; // toplam kaç tool çalıştı

      // Sohbet geçmişi (tool döngüsünde büyür).
      const messages: ChatMesaji[] = [
        { role: "system", content: SISTEM_PROMPTU },
        { role: "user", content: metin },
      ];

      try {
        // ==================== ELLE TOOL DÖNGÜSÜ (max 3 tur) ====================
        // Döngüyü bilerek açıkça bir while ile yazıyoruz (gizli soyutlama yok):
        //   1) OpenAI'ı çağır, akışı oku
        //   2) finish_reason "tool_calls" ise -> tool'ları çalıştır, sonuçları
        //      geçmişe ekle, BAŞA DÖN
        //   3) finish_reason "stop" ise -> nihai JSON hazır, çık
        let tur = 0;
        while (tur < MAKS_TUR) {
          tur++;

          const res = await openAICagir({
            model,
            messages,
            tools: toolTanimlari,
            responseFormat: { type: "json_schema", json_schema: analizJsonSchema() },
            signal: req.signal, // client kopması/Durdur -> upstream abort
          });

          // HTTP seviyesi hatalar (özellikle rate limit).
          if (!res.ok) {
            const hataMetni = await res.text().catch(() => "");
            if (res.status === 429) {
              yaz({
                tip: "hata",
                kind: "rate_limit",
                mesaj:
                  "OpenAI hız sınırına takıldı (429). Biraz bekleyip tekrar deneyin.",
              });
            } else {
              yaz({
                tip: "hata",
                kind: "bilinmeyen",
                mesaj: `OpenAI hatası ${res.status}: ${hataMetni.slice(0, 300)}`,
              });
            }
            yaz({ tip: "bitti" });
            kapat();
            return;
          }

          // Bu tura ait birikimler.
          let icerik = ""; // content (nihai turda JSON metni)
          // tool_call parçaları index'e göre birleştirilir.
          const toolCallBirikim: Record<
            number,
            { id: string; isim: string; args: string }
          > = {};
          let bitisSebebi = "";

          for await (const p of openAIParcalariniOku(res)) {
            if (p.tip === "icerik") {
              icerik += p.delta;
              // İçerik parçasını client'a AYNEN aktar (mod A ve mod B için).
              yaz({ tip: "delta", metin: p.delta });
            } else if (p.tip === "tool_delta") {
              const slot = (toolCallBirikim[p.index] ??= {
                id: "",
                isim: "",
                args: "",
              });
              if (p.id) slot.id = p.id;
              if (p.isim) slot.isim = p.isim;
              if (p.argsDelta) slot.args += p.argsDelta;
            } else if (p.tip === "kullanim") {
              toplamPrompt += p.promptToken;
              toplamCompletion += p.completionToken;
            } else if (p.tip === "bitis") {
              bitisSebebi = p.sebep;
            }
          }

          // ----- Tur bitti: model tool mu istiyor, yoksa cevap mı verdi? -----
          if (bitisSebebi === "tool_calls") {
            const cagrilar = Object.values(toolCallBirikim);

            // Önce assistant'ın tool_calls mesajını geçmişe ekle (OpenAI bunu
            // sonraki turda görmek ISTER; yoksa tool cevaplarını eşleştiremez).
            const asistanToolCalls: OpenAIToolCall[] = cagrilar.map((c) => ({
              id: c.id,
              type: "function",
              function: { name: c.isim, arguments: c.args },
            }));
            messages.push({
              role: "assistant",
              content: icerik || null,
              tool_calls: asistanToolCalls,
            });

            // Sonra her tool'u çalıştır ve sonucunu "tool" mesajı olarak ekle.
            for (const c of cagrilar) {
              toolTuru++;
              let sonucStr: string;
              try {
                const args = guvenliParse(c.args || "{}");
                sonucStr = toolCalistir(c.isim, args);
              } catch (e) {
                // TOOL HATASI: hem kullanıcıya bildir hem de modele geri ver ki
                // düzeltip devam edebilsin.
                const mesaj = (e as Error).message;
                sonucStr = JSON.stringify({ hata: mesaj });
                yaz({
                  tip: "hata",
                  kind: "tool_hatasi",
                  mesaj: `'${c.isim}' tool'u çalışırken hata: ${mesaj}`,
                });
              }
              // UI'da tool turunu göster.
              yaz({
                tip: "tool",
                isim: c.isim,
                args: guvenliParse(c.args || "{}"),
                sonuc: sonucStr,
                tur,
              });
              messages.push({
                role: "tool",
                tool_call_id: c.id,
                content: sonucStr,
              });
            }

            // Döngü başa döner -> modeli tool sonuçlarıyla tekrar çağır.
            continue;
          }

          // ----- finish_reason "stop": nihai JSON cevabı hazır. -----
          // KESİN token/maliyet bilgisini gönder.
          const usd = maliyetHesapla(model, toplamPrompt, toplamCompletion);
          yaz({
            tip: "kullanim",
            promptToken: toplamPrompt,
            completionToken: toplamCompletion,
            toolTuru,
            usd,
          });

          // Sunucu tarafı bir güvenlik ağı: içerik geçerli JSON mı?
          // (Şema uygunluğunu client mod A'da zod ile ayrıca doğruluyoruz.)
          try {
            JSON.parse(icerik);
          } catch {
            yaz({
              tip: "hata",
              kind: "gecersiz_json",
              mesaj: "Model geçerli JSON üretemedi.",
            });
          }

          yaz({ tip: "bitti" });
          kapat();
          return;
        }

        // Buraya düştüysek 3 tur doldu ama model hâlâ tool istiyordu.
        yaz({
          tip: "hata",
          kind: "bilinmeyen",
          mesaj: `Maksimum ${MAKS_TUR} tool turu doldu; sonuç alınamadı.`,
        });
        yaz({ tip: "bitti" });
        kapat();
      } catch (e) {
        // İptal (AbortError) veya beklenmeyen hata.
        if ((e as Error)?.name === "AbortError") {
          // Client durdurdu; sessizce kapat. Client, o ana kadarki (tahmini)
          // maliyeti zaten ekranda tutuyor.
          kapat();
          return;
        }
        yaz({
          tip: "hata",
          kind: "bilinmeyen",
          mesaj: (e as Error)?.message ?? "Bilinmeyen sunucu hatası.",
        });
        yaz({ tip: "bitti" });
        kapat();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}
