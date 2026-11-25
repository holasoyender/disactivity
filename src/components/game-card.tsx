"use client"

import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Info, Play, Square, Loader2, Star, ChevronDown, ListPlus, ListCheck } from "lucide-react"
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from "@/components/ui/tooltip"
import {
    DropdownMenu,
    DropdownMenuContent,
    DropdownMenuItem,
    DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"

export interface Executable {
    name: string
    os?: string
}

export interface Game {
    id: string
    name: string
    icon_hash: string
    executables?: Executable[] | null
    aliases?: string[] | null
    third_party_skus?: { id?: string; sku?: string; distributor: string }[]
}

interface GameCardProps {
    game: Game
    isRunning: boolean
    isLoading: boolean
    isFavorite: boolean
    isInPlaylist?: boolean
    playlistIndex?: number
    isPlaylistFull?: boolean
    maxPlaylistGames?: number
    startTime?: number
    targetDurationMs?: number
    onStart: (game: Game, selectedExecutable?: string) => void
    onStop: (gameId: string) => void
    onToggleFavorite: (gameId: string) => void
    onTogglePlaylist?: (gameId: string) => void
}

function getGameIconUrl(game: Game, size: number = 64): string {
    if (game.icon_hash) {
        return `https://cdn.discordapp.com/app-icons/${game.id}/${game.icon_hash}.png?size=${size}&keep_aspect_ratio=false`
    }
    return "https://cdn.discordapp.com/embed/avatars/0.png"
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000

function formatElapsedTime(ms: number): string {
    const totalSeconds = Math.floor(ms / 1000)
    const hours = Math.floor(totalSeconds / 3600)
    const minutes = Math.floor((totalSeconds % 3600) / 60)
    const seconds = totalSeconds % 60
    const pad = (n: number) => n.toString().padStart(2, "0")
    if (hours > 0) return `${pad(hours)}:${pad(minutes)}:${pad(seconds)}`
    return `${pad(minutes)}:${pad(seconds)}`
}

export function GameCard({
    game,
    isRunning,
    isLoading,
    isFavorite,
    isInPlaylist = false,
    playlistIndex,
    isPlaylistFull = false,
    maxPlaylistGames = 10,
    startTime,
    targetDurationMs = FIFTEEN_MINUTES_MS,
    onStart,
    onStop,
    onToggleFavorite,
    onTogglePlaylist,
}: GameCardProps) {
    const { t } = useTranslation()
    const [elapsed, setElapsed] = useState(0)

    useEffect(() => {
        if (!isRunning || !startTime) {
            setElapsed(0)
            return
        }
        setElapsed(Date.now() - startTime)
        const interval = setInterval(() => {
            setElapsed(Date.now() - startTime)
        }, 1000)
        return () => clearInterval(interval)
    }, [isRunning, startTime])

    const progress = Math.min((elapsed / targetDurationMs) * 100, 100)

    const win32Executables = (game.executables || []).filter(
        (exe) => exe.os === "win32" && !exe.name.startsWith(">")
    )
    const hasMultipleExecutables = win32Executables.length > 1
    const hasSteamSku = game.third_party_skus?.some((sku) => sku.distributor === "steam" && (sku.id || sku.sku)) ?? false
    const hasRunOptions = hasMultipleExecutables || (hasSteamSku && win32Executables.length > 0)

    const handleClick = () => {
        if (isRunning) {
            onStop(game.id)
        } else {
            onStart(game)
        }
    }

    return (
        <div className={`flex items-center gap-4 p-3 rounded-lg border transition-colors overflow-hidden max-sm:gap-2 max-sm:p-2 ${
            isRunning 
                ? "border-green-500/50 bg-green-500/10 hover:bg-green-500/15" 
                : isFavorite
                    ? "border-yellow-500/50 bg-yellow-500/17 hover:bg-yellow-500/25"
                    : "border-border/50 bg-card/50 backdrop-blur-sm hover:bg-accent/30"
        }`}>
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md bg-muted/50 max-sm:h-11 max-sm:w-11">
                <img
                    src={getGameIconUrl(game, 128)}
                    alt={game.name}
                    className="object-cover w-full h-full"
                    onError={(e) => {
                        (e.target as HTMLImageElement).src = "/placeholder.svg"
                    }}
                />
                {isRunning && (
                    <div className="absolute inset-0 flex items-center justify-center bg-green-500/20">
                        <div className="w-3 h-3 bg-green-500 rounded-full animate-pulse" />
                    </div>
                )}
            </div>

            <div className="flex-1 min-w-0 overflow-hidden">
                <div className="flex items-center gap-2 min-w-0">
                    <h3 className="font-medium text-foreground truncate min-w-0 max-sm:text-sm">{game.name}</h3>
                    {isInPlaylist && playlistIndex !== undefined && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-primary/15 text-primary font-medium whitespace-nowrap shrink-0 max-sm:text-[10px] max-sm:px-1">
                            #{playlistIndex + 1}
                        </span>
                    )}
                    {isRunning && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-500 font-medium whitespace-nowrap shrink-0 max-sm:text-[10px] max-sm:px-1">
                            {formatElapsedTime(elapsed)}
                        </span>
                    )}
                    <TooltipProvider delayDuration={200}>
                        <Tooltip>
                            <TooltipTrigger asChild>
                                <Info className="h-4 w-4 text-muted-foreground hover:text-foreground cursor-help shrink-0" />
                            </TooltipTrigger>
                            <TooltipContent side="top" className="max-w-xs">
                                <div className="space-y-1">
                                    <p className="font-semibold">{game.name}</p>
                                    <p className="text-xs text-muted-foreground">{t("gameCard.id")}: {game.id}</p>
                                    {game.executables && game.executables.length > 0 && (
                                        <div className="text-xs">
                                            <p className="font-medium">{t("gameCard.executables")}:</p>
                                            <ul className="list-disc list-inside max-h-32 overflow-y-auto">
                                                {game.executables.map((exe, idx) => (
                                                    <li key={idx} className="text-muted-foreground truncate">
                                                        {exe.name} {exe.os && <span className="opacity-70">({exe.os})</span>}
                                                    </li>
                                                ))}
                                            </ul>
                                        </div>
                                    )}
                                </div>
                            </TooltipContent>
                        </Tooltip>
                    </TooltipProvider>
                </div>
                <span className="block truncate max-w-full text-xs text-muted-foreground font-mono max-sm:text-[10px]">{t("gameCard.id")}: {game.id}</span>
                {isRunning && (
                    <div className="mt-1.5 flex items-center gap-2">
                        <div className="flex-1 h-1.5 rounded-full bg-muted/50 overflow-hidden">
                            <div
                                className={`h-full rounded-full transition-all duration-1000 ease-linear ${
                                    progress >= 100 ? "bg-green-500" : "bg-primary"
                                }`}
                                style={{ width: `${progress}%` }}
                            />
                        </div>
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0 max-sm:hidden">
                            {formatElapsedTime(elapsed)} / {formatElapsedTime(targetDurationMs)}
                        </span>
                    </div>
                )}
            </div>

            {onTogglePlaylist && (
                <TooltipProvider delayDuration={200}>
                    <Tooltip>
                        <TooltipTrigger asChild>
                            <Button
                                size="icon"
                                variant="ghost"
                                className="shrink-0 h-8 w-8 max-sm:h-7 max-sm:w-7"
                                onClick={() => onTogglePlaylist(game.id)}
                                aria-label={isInPlaylist ? t("playlist.remove") : t("playlist.add")}
                            >
                                {isInPlaylist ? (
                                    <ListCheck className="h-4 w-4 text-primary transition-colors" />
                                ) : (
                                    <ListPlus
                                        className={`h-4 w-4 transition-colors ${
                                            isPlaylistFull
                                                ? "text-muted-foreground/40"
                                                : "text-muted-foreground hover:text-primary"
                                        }`}
                                    />
                                )}
                            </Button>
                        </TooltipTrigger>
                        <TooltipContent side="top">
                            {isInPlaylist
                                ? t("playlist.remove")
                                : isPlaylistFull
                                    ? t("playlist.full", { max: maxPlaylistGames })
                                    : t("playlist.add")}
                        </TooltipContent>
                    </Tooltip>
                </TooltipProvider>
            )}

            <TooltipProvider delayDuration={200}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            size="icon"
                            variant="ghost"
                            className="shrink-0 h-8 w-8 max-sm:h-7 max-sm:w-7"
                            onClick={() => onToggleFavorite(game.id)}
                        >
                            <Star
                                className={`h-4 w-4 transition-colors ${
                                    isFavorite 
                                        ? "fill-yellow-500 text-yellow-500" 
                                        : "text-muted-foreground hover:text-yellow-500"
                                }`}
                            />
                        </Button>
                    </TooltipTrigger>
                    <TooltipContent side="top">
                        {isFavorite ? t("favorites.remove") : t("favorites.add")}
                    </TooltipContent>
                </Tooltip>
            </TooltipProvider>

            <div className="flex shrink-0">
                <Button
                    size="sm"
                    onClick={handleClick}
                    className={`shrink-0 max-sm:h-8 max-sm:px-2 ${!isRunning && hasRunOptions ? "rounded-r-none" : ""}`}
                    variant={isRunning ? "destructive" : "default"}
                    disabled={isLoading}
                >
                    {isLoading ? (
                        <Loader2 className="h-4 w-4 mr-1.5 animate-spin" />
                    ) : isRunning ? (
                        <Square className="h-4 w-4 mr-1.5" />
                    ) : (
                        <Play className="h-4 w-4 mr-1.5" />
                    )}
                    <span className="max-[420px]:hidden">{isRunning ? t("actions.stop") : t("actions.run")}</span>
                </Button>
                {!isRunning && hasRunOptions && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="sm"
                                variant="default"
                                className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5 max-sm:h-8"
                                disabled={isLoading}
                            >
                                <ChevronDown className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="max-h-60 overflow-y-auto">
                            {win32Executables.map((exe, idx) => (
                                <DropdownMenuItem
                                    key={idx}
                                    onClick={() => onStart(game, exe.name)}
                                    className="text-xs font-mono cursor-pointer"
                                >
                                    {exe.name}
                                </DropdownMenuItem>
                            ))}
                            {hasSteamSku && (
                                <DropdownMenuItem
                                    onClick={() => onStart(game, "__steam__")}
                                    className="text-xs cursor-pointer"
                                >
                                    {t("gameCard.runViaSteam")}
                                </DropdownMenuItem>
                            )}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
        </div>
    )
}
