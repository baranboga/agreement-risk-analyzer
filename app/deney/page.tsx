"use client";

// app/deney/page.tsx
// -----------------------------------------------------------------------------
// DENEY MODU arayüzü.
//   Amaç: tool tarifindeki kısıtın tool ÇAĞIRMA ORANINI değiştirip
//   değiştirmediğini üç koşulda (A/B/C) ölçüp yan yana karşılaştırmak.
//
//   - Aynı metni, aynı modeli, aynı koşulda N kez SIRAYLA tarar (paralel değil;
//     rate limit yememek için). Her tarama bitince tabloya bir satır eklenir.
//   - Deney NON-STREAMING'tir (bkz. /api/experiment); ölçülen şey süre değil,
//     modelin KARARI (tool'u çağırdı mı, hangi tarihle).
//   - Metin ve model, sonuç varken KİLİTLENİR; böylece koşullar arasında tek
//     değişken "koşul" kalır. Değiştirmek için önce sonuçlar temizlenir.
//
// Normal tarama akışı (app/page.tsx) buradan tamamen bağımsızdır.
// -----------------------------------------------------------------------------

import { useEffect, useState } from "react";
import { ORNEKLER } from "@/lib/ornekler";
import { FIYATLAR, type ModelAdi } from "@/lib/cost";
import { sistemPromptu } from "@/lib/prompt";
import { KISIT_METNI, type DeneyKosulu, type DeneySonucu } from "@/lib/deney";

// Client tarafı "bugün" (YYYY-MM-DD). Yalnızca effect/handler içinde çağrılır.
function bugunBul(): string {
  return new Date().toISOString().slice(0, 10);
}

// Üç koşulun ekranda gösterilecek etiketleri.
const KOSULLAR: { deger: DeneyKosulu; ad: string; aciklama: string }[] = [
  { deger: "A", ad: "A — Kısıt yok", aciklama: "Ne tool ne system prompt" },
  { deger: "B", ad: "B — Sadece tool", aciklama: "Kısıt yalnızca tool tarifinde" },
  { deger: "C", ad: "C — Tool + system", aciklama: "Kısıt her ikisinde" },
];

type Sonuclar = Record<DeneyKosulu, DeneySonucu[]>;
const bosSonuc = (): Sonuclar => ({ A: [], B: [], C: [] });

// Bir koşulun satırlarından özet çıkarır.
function ozetle(satirlar: DeneySonucu[]) {
  const n = satirlar.length;
  const toolCagrilan = satirlar.filter((s) => s.toolCagriSayisi > 0).length;
  const ortBulgu = n
    ? satirlar.reduce((a, s) => a + s.bulguSayisi, 0) / n
    : 0;
  const toplamUsd = satirlar.reduce((a, s) => a + s.usd, 0);
  return { n, toolCagrilan, ortBulgu, toplamUsd };
}

export default function DeneySayfasi() {
  // Deney parametreleri (sonuç varken kilitlenir).
  const [ornekId, setOrnekId] = useState(ORNEKLER[0].id);
  const [metin, setMetin] = useState(ORNEKLER[0].metin);
  const [model, setModel] = useState<ModelAdi>("gpt-4.1");
  // Düzenlenebilir base system prompt. Başlangıç boş; hydration uyuşmazlığı
  // olmasın diye mount sonrası (aşağıdaki effect) varsayılanla doldurulur.
  const [prompt, setPrompt] = useState("");

  // Koşul ve tekrar sayısı (çalışırken hariç serbest).
  const [kosul, setKosul] = useState<DeneyKosulu>("A");
  const [tekrar, setTekrar] = useState(5);

  const [calisiyor, setCalisiyor] = useState(false);
  const [ilerleme, setIlerleme] = useState<string | null>(null);
  const [sonuclar, setSonuclar] = useState<Sonuclar>(bosSonuc);
  const [hata, setHata] = useState<string | null>(null);

  const sonucVar =
    sonuclar.A.length + sonuclar.B.length + sonuclar.C.length > 0;
  const bosMu = !metin.trim();
  // Sonuç varken metin/prompt/model kilitli: koşullar arası tek değişken
  // "koşul" olsun (base prompt üç koşulda da aynı kalmalı).
  const kilit = sonucVar || calisiyor;

  // Varsayılan sistem promptunu ilk mount'ta (client) doldur.
  useEffect(() => {
    setPrompt(sistemPromptu(bugunBul()));
  }, []);

  function ornekSec(id: string) {
    const o = ORNEKLER.find((x) => x.id === id);
    if (!o) return;
    setOrnekId(id);
    setMetin(o.metin);
  }

  function promptuSifirla() {
    setPrompt(sistemPromptu(bugunBul()));
  }

  async function calistir() {
    if (calisiyor || bosMu) return;
    setHata(null);
    setCalisiyor(true);

    const n = Math.max(1, Math.min(50, Math.floor(tekrar) || 1));
    try {
      // SIRAYLA (paralel değil): her tarama bitince satırı hemen ekle.
      for (let i = 0; i < n; i++) {
        setIlerleme(`${i + 1}/${n}`);
        const res = await fetch("/api/experiment", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ metin, model, kosul, prompt }),
        });
        const veri = await res.json().catch(() => null);
        if (!res.ok || !veri || veri.hata) {
          // Rate limit vb.: hatayı göster ve kalan turları DURDUR.
          setHata(veri?.hata ?? `Sunucu hatası (${res.status}).`);
          break;
        }
        const satir = veri as DeneySonucu;
        setSonuclar((s) => ({ ...s, [kosul]: [...s[kosul], satir] }));
      }
    } catch (e) {
      setHata((e as Error).message);
    } finally {
      setIlerleme(null);
      setCalisiyor(false);
    }
  }

  function temizle() {
    setSonuclar(bosSonuc());
    setHata(null);
  }

  return (
    <main className="deney-kapsayici">
      <h1>Deney Modu</h1>
      <p className="altbaslik">
        Tool tarifindeki kısıtın tool çağırma oranını değiştirip
        değiştirmediğini ölç. Aynı metin/model, üç koşul (A/B/C), N tekrar.{" "}
        <a className="baglanti" href="/">
          ← Normal tarama
        </a>
      </p>

      <div className="deney-kisit">
        <span className="etiket">Kısıt metni</span>
        <span className="deger">“{KISIT_METNI}”</span>
      </div>

      {/* Giriş metni (sonuç varken kilitli) */}
      <div className="deney-alan-baslik">
        <label>Sözleşme metni</label>
      </div>
      <textarea
        value={metin}
        onChange={(e) => setMetin(e.target.value)}
        placeholder="Sözleşme metnini buraya yapıştırın..."
        disabled={kilit}
      />

      {/* Düzenlenebilir base system prompt (üç koşulda ortak; C'de kısıt sona
          eklenir). Sonuç varken kilitli. */}
      <div className="deney-alan-baslik">
        <label>Sistem promptu (base — üç koşulda ortak; C&apos;de kısıt sona eklenir)</label>
        <button
          type="button"
          className="baglanti"
          onClick={promptuSifirla}
          disabled={kilit}
        >
          Varsayılana döndür
        </button>
      </div>
      <textarea
        className="deney-prompt"
        value={prompt}
        onChange={(e) => setPrompt(e.target.value)}
        placeholder="Sistem promptu…"
        disabled={kilit}
      />

      <div className="satir">
        <label className="secim">
          Örnek:
          <select
            value={ornekId}
            onChange={(e) => ornekSec(e.target.value)}
            disabled={kilit}
          >
            {ORNEKLER.map((o) => (
              <option key={o.id} value={o.id}>
                {o.ad}
              </option>
            ))}
          </select>
        </label>

        <label className="secim">
          Model:
          <select
            value={model}
            onChange={(e) => setModel(e.target.value as ModelAdi)}
            disabled={kilit}
          >
            {Object.keys(FIYATLAR).map((m) => (
              <option key={m} value={m}>
                {m}
              </option>
            ))}
          </select>
        </label>

        <label className="secim">
          Koşul:
          <select
            value={kosul}
            onChange={(e) => setKosul(e.target.value as DeneyKosulu)}
            disabled={calisiyor}
          >
            {KOSULLAR.map((k) => (
              <option key={k.deger} value={k.deger}>
                {k.ad}
              </option>
            ))}
          </select>
        </label>

        <label className="secim">
          N kez:
          <input
            className="deney-sayi"
            type="number"
            min={1}
            max={50}
            value={tekrar}
            onChange={(e) => setTekrar(Number(e.target.value))}
            disabled={calisiyor}
          />
        </label>

        <span className="esne" />

        {ilerleme && <span className="altbaslik">çalışıyor {ilerleme}…</span>}

        <button className="birincil" onClick={calistir} disabled={calisiyor || bosMu}>
          Çalıştır
        </button>
        <button onClick={temizle} disabled={calisiyor || !sonucVar}>
          Sonuçları temizle
        </button>
      </div>

      {kilit && !calisiyor && (
        <p className="altbaslik">
          Metin, sistem promptu ve model kilitli (koşullar arası sabit kalsın
          diye). Değiştirmek için önce “Sonuçları temizle”.
        </p>
      )}

      {hata && (
        <div className="hatalar">
          <div className="hata-kutu">
            <span className="tur">Hata:</span>
            {hata}
          </div>
        </div>
      )}

      {/* Üç koşul yan yana */}
      <div className="deney-panolar">
        {KOSULLAR.map((k) => {
          const satirlar = sonuclar[k.deger];
          const o = ozetle(satirlar);
          const aktif = k.deger === kosul;
          return (
            <div
              className={`deney-pano ${aktif ? "aktif" : ""}`}
              key={k.deger}
            >
              <h3>{k.ad}</h3>
              <div className="pano-alt">{k.aciklama}</div>

              {satirlar.length === 0 ? (
                <div className="deney-bos">Henüz çalıştırılmadı.</div>
              ) : (
                <>
                  <div className="deney-tablo-sar">
                    <table className="deney-tablo">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th title="tool çağrı sayısı">tool</th>
                          <th title="çağrıldıysa gönderilen baslangicTarihi">
                            başl.tarih
                          </th>
                          <th title="bulgu sayısı">bulgu</th>
                          <th title="prompt token">pT</th>
                          <th title="completion token">cT</th>
                          <th title="maliyet (USD)">$</th>
                        </tr>
                      </thead>
                      <tbody>
                        {satirlar.map((s, i) => (
                          <tr key={i}>
                            <td>{i + 1}</td>
                            <td className={s.toolCagriSayisi > 0 ? "evet" : "hayir"}>
                              {s.toolCagriSayisi}
                            </td>
                            <td className={s.baslangicTarihleri.length ? "" : "hayir"}>
                              {s.baslangicTarihleri.length
                                ? s.baslangicTarihleri.join(", ")
                                : "—"}
                            </td>
                            <td>{s.bulguSayisi}</td>
                            <td>{s.promptToken.toLocaleString("tr-TR")}</td>
                            <td>{s.completionToken.toLocaleString("tr-TR")}</td>
                            <td>${s.usd.toFixed(6)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  <div className="deney-ozet">
                    <div className="satir-ozet">
                      <span className="etiket">Tool çağrılan tarama</span>
                      <span className="deger">
                        {o.toolCagrilan}/{o.n}
                      </span>
                    </div>
                    <div className="satir-ozet">
                      <span className="etiket">Ort. bulgu</span>
                      <span className="deger">{o.ortBulgu.toFixed(1)}</span>
                    </div>
                    <div className="satir-ozet">
                      <span className="etiket">Toplam maliyet</span>
                      <span className="deger">${o.toplamUsd.toFixed(6)}</span>
                    </div>
                  </div>
                </>
              )}
            </div>
          );
        })}
      </div>
    </main>
  );
}
