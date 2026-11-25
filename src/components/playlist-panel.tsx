"use client"

import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
    ListVideo,
    Play,
    Square,
    SkipForward,
    Trash2,
    ChevronUp,
    ChevronDown,
    X,
    Clock,
    Timer,
    Hourglass,
    Check,
    Loader2,
} from "lucide-react"
import type { Game } from "@/components/game-card"

export const MAX_PLAYLIST_GAMES = 10
export const DEFAULT_PLAY_DURATION_MINUTES = 15
export const MIN_PLAY_DURATION_MINUTES = 1
export const MAX_PLAY_DURATION_MINUTES = 1440
export const DEFAULT_BREAK_INTERVAL_MINUTES = 5
export const MIN_BREAK_INTERVAL_MINUTES = 0
export const MAX_BREAK_INTERVAL_MINUTES = 1440

export type PlaylistPhase = "idle" | "playing" | "break"

interface PlaylistPanelProps {
    games: Game[]
    playDurationMinutes: number
    breakIntervalMinutes: number
    phase: PlaylistPhase
    currentGameId: string | null
    phaseStartedAt: number | null
    completedIds: Set<string>
    loadingGames: Set<string>
    onPlayDurationChange: (minutes: number) => void
    onBreakIntervalChange: (minutes: number) => void
    onStart: () => void
    onStop: () => void
    onSkip: () => void
    onClear: () => void
    onRemove: (gameId: string) => void
    onMove: (index: number, direction: -1 | 1) => void
}

function getGameIconUrl(game: Game, size: number = 64): string {
    if (game.icon_hash) {
        return `https://cdn.discordapp.com/app-icons/${game.id}/${game.icon_hash}.png?size=${size}&keep_aspect_ratio=false`
    }
    return "https://cdn.discordapp.com/embed/avatars/0.png"
}

function formatDuration(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000))
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const pad = (n: number) => n.toString().padStart(2, "0")
    if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    return `${pad(minutes)}:${pad(seconds)}`
}

export function PlaylistPanel({
    games,
    playDurationMinutes,
    breakIntervalMinutes,
    phase,
    currentGameId,
    phaseStartedAt,
    completedIds,
    loadingGames,
    onPlayDurationChange,
    onBreakIntervalChange,
    onStart,
    onStop,
    onSkip,
    onClear,
    onRemove,
    onMove,
}: PlaylistPanelProps) {
    const { t } = useTranslation()
    const [playInput, setPlayInput] = useState(String(playDurationMinutes))
    const [breakInput, setBreakInput] = useState(String(breakIntervalMinutes))
    const [now, setNow] = useState(Date.now())

    const isActive = phase !== "idle"
    const isPlaying = phase === "playing"
    const isBreak = phase === "break"

    useEffect(() => {
        setPlayInput(String(playDurationMinutes))
    }, [playDurationMinutes])

    useEffect(() => {
        setBreakInput(String(breakIntervalMinutes))
    }, [breakIntervalMinutes])

    useEffect(() => {
        if (!isActive || !phaseStartedAt) return
        setNow(Date.now())
        const timer = setInterval(() => setNow(Date.now()), 1000)
        return () => clearInterval(timer)
    }, [isActive, phaseStartedAt])

    const targetMs = (isBreak ? breakIntervalMinutes : playDurationMinutes) * 60 * 1000
    const elapsedMs = isActive && phaseStartedAt ? Math.max(0, now - phaseStartedAt) : 0
    const remainingMs = Math.max(0, targetMs - elapsedMs)
    const progress = targetMs > 0 ? Math.min((elapsedMs / targetMs) * 100, 100) : 100

    const currentIndex = currentGameId ? games.findIndex((g) => g.id === currentGameId) : -1
    const currentGame = currentIndex >= 0 ? games[currentIndex] : null

    const handlePlayInputChange = (value: string) => {
        setPlayInput(value)
        const parsed = parseInt(value, 10)
        if (!isNaN(parsed) && parsed >= MIN_PLAY_DURATION_MINUTES && parsed <= MAX_PLAY_DURATION_MINUTES) {
            onPlayDurationChange(parsed)
        }
    }

    const handlePlayInputBlur = () => {
        const parsed = parseInt(playInput, 10)
        if (isNaN(parsed)) {
            setPlayInput(String(playDurationMinutes))
            return
        }
        const clamped = Math.max(MIN_PLAY_DURATION_MINUTES, Math.min(MAX_PLAY_DURATION_MINUTES, parsed))
        onPlayDurationChange(clamped)
        setPlayInput(String(clamped))
    }

    const handleBreakInputChange = (value: string) => {
        setBreakInput(value)
        const parsed = parseInt(value, 10)
        if (!isNaN(parsed) && parsed >= MIN_BREAK_INTERVAL_MINUTES && parsed <= MAX_BREAK_INTERVAL_MINUTES) {
            onBreakIntervalChange(parsed)
        }
    }

    const handleBreakInputBlur = () => {
        const parsed = parseInt(breakInput, 10)
        if (isNaN(parsed)) {
            setBreakInput(String(breakIntervalMinutes))
            return
        }
        const clamped = Math.max(MIN_BREAK_INTERVAL_MINUTES, Math.min(MAX_BREAK_INTERVAL_MINUTES, parsed))
        onBreakIntervalChange(clamped)
        setBreakInput(String(clamped))
    }

    return (
        <div className="mb-4 rounded-lg border border-border/50 bg-card/60 backdrop-blur-sm p-3 max-sm:p-2">
            {/* Header & Playback Controls */}
            <div className="flex items-center justify-between gap-2 flex-wrap">
                <div className="flex items-center gap-2 min-w-0">
                    <ListVideo
                        className={`h-4 w-4 shrink-0 ${
                            isPlaying ? "text-green-500" : isBreak ? "text-amber-500" : "text-primary"
                        }`}
                    />
                    <h2 className="text-sm font-semibold text-foreground truncate">{t("playlist.title")}</h2>
                    <span className="text-xs text-muted-foreground whitespace-nowrap">
                        ({games.length}/{MAX_PLAYLIST_GAMES})
                    </span>
                    {isActive && currentIndex >= 0 && (
                        <span
                            className={`text-xs px-1.5 py-0.5 rounded font-medium whitespace-nowrap ${
                                isBreak
                                    ? "bg-amber-500/20 text-amber-500"
                                    : "bg-green-500/20 text-green-500"
                            }`}
                        >
                            {t("playlist.progress", { current: currentIndex + 1, total: games.length })}
                        </span>
                    )}
                </div>

                <div className="flex items-center gap-2 flex-wrap">
                    {isActive ? (
                        <>
                            {(isBreak || games.length > 1) && (
                                <TooltipProvider delayDuration={200}>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                size="sm"
                                                variant="outline"
                                                className="h-7 px-2 text-xs bg-background"
                                                onClick={onSkip}
                                                aria-label={isBreak ? t("playlist.skipBreak") : t("playlist.skip")}
                                            >
                                                <SkipForward className="h-3.5 w-3.5" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent side="top">
                                            {isBreak ? t("playlist.skipBreak") : t("playlist.skip")}
                                        </TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            )}
                            <Button
                                size="sm"
                                variant="destructive"
                                className="h-7 px-2.5 text-xs"
                                onClick={onStop}
                            >
                                <Square className="h-3.5 w-3.5 mr-1" />
                                {t("playlist.stop")}
                            </Button>
                        </>
                    ) : (
                        <>
                            {games.length > 0 && (
                                <TooltipProvider delayDuration={200}>
                                    <Tooltip>
                                        <TooltipTrigger asChild>
                                            <Button
                                                size="sm"
                                                variant="ghost"
                                                className="h-7 px-2 text-xs text-muted-foreground hover:text-destructive"
                                                onClick={onClear}
                                                aria-label={t("playlist.clear")}
                                            >
                                                <Trash2 className="h-3.5 w-3.5" />
                                            </Button>
                                        </TooltipTrigger>
                                        <TooltipContent side="top">{t("playlist.clear")}</TooltipContent>
                                    </Tooltip>
                                </TooltipProvider>
                            )}
                            <Button
                                size="sm"
                                variant="default"
                                className="h-7 px-2.5 text-xs"
                                onClick={onStart}
                                disabled={games.length === 0}
                            >
                                <Play className="h-3.5 w-3.5 mr-1" />
                                {t("playlist.start")}
                            </Button>
                        </>
                    )}
                </div>
            </div>

            {/* Timing Configuration Bar */}
            <div className="mt-2.5 flex items-center justify-between gap-3 flex-wrap rounded-md border border-border/40 bg-background/50 px-2.5 py-2">
                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Timer className="h-3.5 w-3.5 shrink-0 text-primary" />
                    <label htmlFor="playlist-play-duration" className="font-medium text-foreground/90 whitespace-nowrap">
                        {t("playlist.playDurationLabel")}:
                    </label>
                    <Input
                        id="playlist-play-duration"
                        type="number"
                        min={MIN_PLAY_DURATION_MINUTES}
                        max={MAX_PLAY_DURATION_MINUTES}
                        value={playInput}
                        onChange={(e) => handlePlayInputChange(e.target.value)}
                        onBlur={handlePlayInputBlur}
                        className="w-16 h-7 text-center text-xs px-1.5 bg-background"
                    />
                    <span>{t("playlist.minutesShort")}</span>
                </div>

                <div className="flex items-center gap-2 text-xs text-muted-foreground">
                    <Clock className="h-3.5 w-3.5 shrink-0 text-amber-500" />
                    <label htmlFor="playlist-break-interval" className="font-medium text-foreground/90 whitespace-nowrap">
                        {t("playlist.breakIntervalLabel")}:
                    </label>
                    <Input
                        id="playlist-break-interval"
                        type="number"
                        min={MIN_BREAK_INTERVAL_MINUTES}
                        max={MAX_BREAK_INTERVAL_MINUTES}
                        value={breakInput}
                        onChange={(e) => handleBreakInputChange(e.target.value)}
                        onBlur={handleBreakInputBlur}
                        className="w-16 h-7 text-center text-xs px-1.5 bg-background"
                    />
                    <span>{t("playlist.minutesShort")}</span>
                </div>
            </div>

            {/* Active Playback / Break Progress */}
            {isActive && currentGame && (
                <div
                    className={`mt-2.5 p-2 rounded-md border ${
                        isBreak
                            ? "bg-amber-500/10 border-amber-500/30"
                            : "bg-green-500/10 border-green-500/30"
                    }`}
                >
                    <div className="flex items-center justify-between gap-2 text-xs mb-1.5 flex-wrap">
                        <div className="flex items-center gap-1.5 min-w-0">
                            {isBreak ? (
                                <Hourglass className="h-3.5 w-3.5 text-amber-500 animate-pulse shrink-0" />
                            ) : (
                                <span className="h-2 w-2 rounded-full bg-green-500 animate-pulse shrink-0" />
                            )}
                            <span className="font-medium text-foreground truncate">
                                {isBreak
                                    ? t("playlist.breakStatus", { name: currentGame.name })
                                    : currentGame.name}
                            </span>
                        </div>
                        <span className="text-muted-foreground whitespace-nowrap shrink-0 font-mono text-[11px]">
                            {formatDuration(elapsedMs)} / {formatDuration(targetMs)} •{" "}
                            {t("playlist.remaining", { time: formatDuration(remainingMs) })}
                        </span>
                    </div>
                    <div className="h-1.5 rounded-full bg-muted/60 overflow-hidden">
                        <div
                            className={`h-full rounded-full transition-all duration-1000 ease-linear ${
                                isBreak ? "bg-amber-500" : "bg-green-500"
                            }`}
                            style={{ width: `${progress}%` }}
                        />
                    </div>
                </div>
            )}

            {/* Queue Items */}
            {games.length === 0 ? (
                <p className="mt-2.5 text-xs text-muted-foreground text-center py-3">
                    {t("playlist.empty", { max: MAX_PLAYLIST_GAMES })}
                </p>
            ) : (
                <div className="mt-2.5 space-y-1">
                    {games.map((game, index) => {
                        const isCurrentPlaying = isPlaying && currentGameId === game.id
                        const isUpNext = isBreak && currentGameId === game.id
                        const isCompleted = completedIds.has(game.id)
                        const isLoading = loadingGames.has(game.id)

                        return (
                            <div
                                key={game.id}
                                className={`flex items-center gap-2.5 px-2.5 py-1.5 rounded-md border transition-colors ${
                                    isCurrentPlaying
                                        ? "border-green-500/50 bg-green-500/10"
                                        : isUpNext
                                            ? "border-amber-500/50 bg-amber-500/10"
                                            : isCompleted
                                                ? "border-border/30 bg-muted/20 opacity-70"
                                                : "border-border/40 bg-background/50 hover:bg-accent/30"
                                }`}
                            >
                                <div className="w-5 flex items-center justify-center shrink-0">
                                    {isLoading ? (
                                        <Loader2 className="h-3.5 w-3.5 animate-spin text-primary" />
                                    ) : isCurrentPlaying ? (
                                        <span className="h-2.5 w-2.5 rounded-full bg-green-500 animate-pulse" />
                                    ) : isUpNext ? (
                                        <Hourglass className="h-3.5 w-3.5 text-amber-500" />
                                    ) : isCompleted ? (
                                        <Check className="h-3.5 w-3.5 text-green-500" />
                                    ) : (
                                        <span className="text-xs font-mono text-muted-foreground">{index + 1}</span>
                                    )}
                                </div>

                                <img
                                    src={getGameIconUrl(game, 64)}
                                    alt={game.name}
                                    className="h-7 w-7 rounded object-cover bg-muted shrink-0"
                                    onError={(e) => {
                                        ;(e.target as HTMLImageElement).src = "https://cdn.discordapp.com/embed/avatars/0.png"
                                    }}
                                />

                                <div className="flex-1 min-w-0">
                                    <p className="text-xs font-medium text-foreground truncate">{game.name}</p>
                                </div>

                                {isCurrentPlaying && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-green-500/20 text-green-500 font-medium whitespace-nowrap shrink-0 max-sm:hidden">
                                        {t("playlist.playing")}
                                    </span>
                                )}
                                {isUpNext && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-500 font-medium whitespace-nowrap shrink-0 max-sm:hidden">
                                        {t("playlist.upNext")}
                                    </span>
                                )}
                                {!isCurrentPlaying && !isUpNext && isCompleted && (
                                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-muted text-muted-foreground font-medium whitespace-nowrap shrink-0 max-sm:hidden">
                                        {t("playlist.completed")}
                                    </span>
                                )}

                                <div className="flex items-center gap-0.5 shrink-0">
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        onClick={() => onMove(index, -1)}
                                        disabled={index === 0}
                                        aria-label={t("playlist.moveUp")}
                                        className="text-muted-foreground hover:text-foreground"
                                    >
                                        <ChevronUp className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        onClick={() => onMove(index, 1)}
                                        disabled={index === games.length - 1}
                                        aria-label={t("playlist.moveDown")}
                                        className="text-muted-foreground hover:text-foreground"
                                    >
                                        <ChevronDown className="h-3.5 w-3.5" />
                                    </Button>
                                    <Button
                                        size="icon-xs"
                                        variant="ghost"
                                        onClick={() => onRemove(game.id)}
                                        aria-label={t("playlist.remove")}
                                        className="text-muted-foreground hover:text-destructive"
                                    >
                                        <X className="h-3.5 w-3.5" />
                                    </Button>
                                </div>
                            </div>
                        )
                    })}
                </div>
            )}
        </div>
    )
}
