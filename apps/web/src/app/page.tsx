"use client";

import { useCallback, useEffect, useState } from "react";
import { publicConfig } from "@/shared/lib/config";

type ApiStatus =
  | { state: "loading" }
  | { state: "connected"; message: string }
  | { state: "error"; message: string };

const apiUrl = publicConfig.NEXT_PUBLIC_API_URL;

export default function Home() {
  const [apiStatus, setApiStatus] = useState<ApiStatus>({
    state: "loading",
  });

  const checkApi = useCallback(async () => {
    setApiStatus({ state: "loading" });

    try {
      const response = await fetch(`${apiUrl}/health`);

      if (!response.ok) {
        throw new Error(`Réponse HTTP ${response.status}`);
      }

      const data: { status: string; message: string } = await response.json();

      if (data.status !== "ok") {
        throw new Error("L’API a retourné un état invalide");
      }

      setApiStatus({
        state: "connected",
        message: data.message,
      });
    } catch {
      setApiStatus({
        state: "error",
        message: "Impossible de joindre l’API ReLiS",
      });
    }
  }, []);

  useEffect(() => {
    void checkApi();
  }, [checkApi]);

  return (
    <main className="flex min-h-screen items-center justify-center bg-slate-950 px-6 text-white">
      <section className="w-full max-w-2xl rounded-3xl border border-white/10 bg-white/5 p-10 text-center shadow-2xl">
        <p className="mb-4 text-sm font-semibold uppercase tracking-[0.3em] text-blue-400">
          ReLiS
        </p>

        <h1 className="text-4xl font-bold tracking-tight sm:text-5xl">
          Bienvenue dans le nouveau ReLiS
        </h1>

        <p className="mt-5 text-lg text-slate-300">
          Le socle Web, API et TypeScript est opérationnel.
        </p>

        <div
          className={`mt-8 rounded-2xl border p-5 ${
            apiStatus.state === "connected"
              ? "border-emerald-500/30 bg-emerald-500/10"
              : apiStatus.state === "error"
                ? "border-red-500/30 bg-red-500/10"
                : "border-blue-500/30 bg-blue-500/10"
          }`}
        >
          {apiStatus.state === "loading" && (
            <p className="text-blue-300">Connexion à l’API…</p>
          )}

          {apiStatus.state === "connected" && (
            <>
              <p className="font-semibold text-emerald-300">API connectée ✓</p>
              <p className="mt-1 text-sm text-slate-300">{apiStatus.message}</p>
            </>
          )}

          {apiStatus.state === "error" && (
            <>
              <p className="font-semibold text-red-300">API non disponible</p>
              <p className="mt-1 text-sm text-slate-300">{apiStatus.message}</p>
              <button
                type="button"
                onClick={() => void checkApi()}
                className="mt-4 rounded-full bg-white px-5 py-2 text-sm font-medium text-slate-950"
              >
                Réessayer
              </button>
            </>
          )}
        </div>
      </section>
    </main>
  );
}
