import { NextRequest, NextResponse } from "next/server";
import {
  getSixStageRealFeatureDiscovery,
  getSixStageRealPatternDetail,
  getSixStageRealResearchMeta,
  listSixStageRealPatternRankings,
  type SixStageAvailableFeature,
  type SixStageRankingSort,
  type SixStageRankingWeights,
  type SixStageResearchDirection,
} from "@/lib/server/six-stage-real-research-store";
import type { SixStageRealMarket } from "@/lib/research/six-stage-real-data-contract";
import { isSixStageResearchRequestAllowed } from "@/lib/research/six-stage-research-isolation";

export const dynamic = "force-dynamic";
export const revalidate = 0;

function integer(raw: string | null, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value)) throw new Error("invalid_integer");
  return value;
}

function number(raw: string | null, fallback: number): number {
  if (raw == null || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value)) throw new Error("invalid_number");
  return value;
}

function market(request: NextRequest): SixStageRealMarket {
  const value = request.nextUrl.searchParams.get("market")?.toUpperCase();
  if (value !== "JP" && value !== "US") throw new Error("invalid_market");
  return value;
}

function direction(request: NextRequest): SixStageResearchDirection {
  const value = request.nextUrl.searchParams.get("direction")?.toUpperCase();
  if (value !== "LONG" && value !== "SHORT")
    throw new Error("invalid_direction");
  return value;
}

function rankingWeights(request: NextRequest): Partial<SixStageRankingWeights> {
  const parameters: Array<[keyof SixStageRankingWeights, string]> = [
    ["first5", "wFirst5"],
    ["hit10", "wHit10"],
    ["median", "wMedian"],
    ["mfe", "wMfe"],
    ["mae", "wMae"],
    ["samples", "wSamples"],
    ["concentration", "wConcentration"],
    ["outlier", "wOutlier"],
    ["quality", "wQuality"],
  ];
  return Object.fromEntries(
    parameters
      .filter(([, parameter]) => request.nextUrl.searchParams.has(parameter))
      .map(([key, parameter]) => [
        key,
        number(request.nextUrl.searchParams.get(parameter), 0),
      ]),
  );
}

export async function GET(request: NextRequest) {
  if (!isSixStageResearchRequestAllowed({
    mode: "real",
    hostname: request.nextUrl.hostname,
    headers: request.headers,
  })) {
    return new NextResponse("Not Found", { status: 404 });
  }
  try {
    const view = request.nextUrl.searchParams.get("view") ?? "meta";
    const payload =
      view === "meta"
        ? getSixStageRealResearchMeta()
        : view === "ranking"
          ? listSixStageRealPatternRankings({
              market: market(request),
              length: integer(request.nextUrl.searchParams.get("length"), 2) as
                2 | 3,
              horizon: integer(request.nextUrl.searchParams.get("horizon"), 20),
              direction: direction(request),
              sort: (request.nextUrl.searchParams.get("sort") ??
                "first5") as SixStageRankingSort,
              page: integer(request.nextUrl.searchParams.get("page"), 1),
              pageSize: integer(
                request.nextUrl.searchParams.get("pageSize"),
                50,
              ),
              search: request.nextUrl.searchParams.get("search"),
              weights: rankingWeights(request),
            })
          : view === "detail"
            ? getSixStageRealPatternDetail({
                market: market(request),
                length: integer(
                  request.nextUrl.searchParams.get("length"),
                  2,
                ) as 2 | 3,
                sequenceKey:
                  request.nextUrl.searchParams.get("sequenceKey") ?? "",
                horizon: integer(
                  request.nextUrl.searchParams.get("horizon"),
                  20,
                ),
                direction: direction(request),
                favorablePct: number(
                  request.nextUrl.searchParams.get("favorablePct"),
                  5,
                ),
                adversePct: number(
                  request.nextUrl.searchParams.get("adversePct"),
                  5,
                ),
                ticker: request.nextUrl.searchParams.get("ticker"),
                year: request.nextUrl.searchParams.has("year")
                  ? integer(request.nextUrl.searchParams.get("year"), 0)
                  : null,
                feature: request.nextUrl.searchParams.get(
                  "feature",
                ) as SixStageAvailableFeature | null,
              })
            : view === "feature-discovery"
              ? getSixStageRealFeatureDiscovery({
                  market: market(request),
                  length: integer(
                    request.nextUrl.searchParams.get("length"),
                    2,
                  ) as 2 | 3,
                  sequenceKey:
                    request.nextUrl.searchParams.get("sequenceKey") ?? "",
                  horizon: integer(
                    request.nextUrl.searchParams.get("horizon"),
                    20,
                  ),
                  direction: direction(request),
                  favorablePct: number(
                    request.nextUrl.searchParams.get("favorablePct"),
                    5,
                  ),
                  adversePct: number(
                    request.nextUrl.searchParams.get("adversePct"),
                    5,
                  ),
                  featureA: (request.nextUrl.searchParams.get("featureA") ??
                    "sma25Angle") as SixStageAvailableFeature,
                  featureB: (request.nextUrl.searchParams.get("featureB") ??
                    "momentum") as SixStageAvailableFeature,
                  bins: integer(request.nextUrl.searchParams.get("bins"), 5),
                })
            : (() => {
                throw new Error("invalid_view");
              })();
    return NextResponse.json(payload, {
      headers: { "Cache-Control": "no-store" },
    });
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "real_research_request_failed";
    if (message.startsWith("invalid_")) {
      return NextResponse.json(
        { error: message },
        { status: 400, headers: { "Cache-Control": "no-store" } },
      );
    }
    const unavailable =
      message.includes("unavailable") ||
      message.includes("mismatch") ||
      message.includes("required") ||
      message.includes("input missing");
    console.error("[six-stage-real-event-paths]", message);
    return NextResponse.json(
      {
        error: unavailable
          ? "real_research_store_unavailable"
          : "real_research_request_failed",
      },
      {
        status: unavailable ? 503 : 500,
        headers: { "Cache-Control": "no-store" },
      },
    );
  }
}
