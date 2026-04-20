"use client"

import { useState, useEffect } from "react"
import { useTranslation } from "react-i18next"
import { Button } from "@/components/ui/button"
import { Info, Play, Square, Loader2, Star, ChevronDown } from "lucide-react"
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

export interface ThirdPartySku {
    distributor?: string | null
    id?: string | null
}

export interface Game {
    id: string
    name: string
    icon_hash: string
    executables?: Executable[] | null
    aliases?: string[] | null
    third_party_skus?: ThirdPartySku[] | null
}

interface GameCardProps {
    game: Game
    isRunning: boolean
    isLoading: boolean
    isFavorite: boolean
    startTime?: number
    onStart: (game: Game, selectedExecutable?: string) => void
    onStartSteam: (game: Game, steamId: string) => void
    onStop: (gameId: string) => void
    onToggleFavorite: (gameId: string) => void
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

export function GameCard({ game, isRunning, isLoading, isFavorite, startTime, onStart, onStartSteam, onStop, onToggleFavorite }: GameCardProps) {
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

    const progress = Math.min((elapsed / FIFTEEN_MINUTES_MS) * 100, 100)

    const win32Executables = (game.executables || []).filter(
        (exe) => exe.os === "win32" && !exe.name.startsWith(">")
    )
    const hasMultipleExecutables = win32Executables.length > 1
    const hasExecutables = win32Executables.length > 0

    // Get Steam SKUs (only those with valid distributor and id)
    const steamSkus = (game.third_party_skus || []).filter(
        (sku) => sku.distributor === "steam" && typeof sku.id === "string"
    ) as Array<{ distributor: string; id: string }>
    const hasSteamSkus = steamSkus.length > 0
    const isSteamOnly = !hasExecutables && hasSteamSkus

    const handleClick = () => {
        if (isRunning) {
            onStop(game.id)
        } else if (isSteamOnly) {
            // Launch via Steam with the first Steam ID
            onStartSteam(game, steamSkus[0].id)
        } else {
            onStart(game)
        }
    }

    return (
        <div className={`flex items-center gap-4 p-3 rounded-lg border transition-colors overflow-hidden ${
            isRunning 
                ? "border-green-500/50 bg-green-500/10 hover:bg-green-500/15" 
                : isFavorite
                    ? "border-yellow-500/50 bg-yellow-500/17 hover:bg-yellow-500/25"
                    : "border-border/50 bg-card/50 backdrop-blur-sm hover:bg-accent/30"
        }`}>
            <div className="relative h-14 w-14 shrink-0 overflow-hidden rounded-md bg-muted/50">
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
                    <h3 className="font-medium text-foreground truncate min-w-0">{game.name}</h3>
                    {isRunning && (
                        <span className="text-xs px-1.5 py-0.5 rounded bg-green-500/20 text-green-500 font-medium whitespace-nowrap shrink-0">
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
                                    {steamSkus.length > 0 && (
                                        <div className="text-xs">
                                            <p className="font-medium">Steam:</p>
                                            <ul className="list-disc list-inside">
                                                {steamSkus.map((sku, idx) => (
                                                    <li key={idx} className="text-muted-foreground">
                                                        App ID: {sku.id}
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
                <span className="text-xs text-muted-foreground font-mono">{t("gameCard.id")}: {game.id}</span>
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
                        <span className="text-[10px] text-muted-foreground whitespace-nowrap shrink-0">
                            {formatElapsedTime(elapsed)} / 15:00
                        </span>
                    </div>
                )}
            </div>

            <TooltipProvider delayDuration={200}>
                <Tooltip>
                    <TooltipTrigger asChild>
                        <Button
                            size="icon"
                            variant="ghost"
                            className="shrink-0 h-8 w-8"
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
                {isSteamOnly && !isRunning && (
                    <span className="text-[10px] px-1.5 py-0.5 rounded bg-blue-500/20 text-blue-400 font-medium whitespace-nowrap shrink-0 self-center mr-2">
                        Steam
                    </span>
                )}
                <Button
                    size="sm"
                    onClick={handleClick}
                    className={`shrink-0 ${!isRunning && (hasMultipleExecutables || (hasExecutables && hasSteamSkus) || steamSkus.length > 1) ? "rounded-r-none" : ""}`}
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
                    {isRunning ? t("actions.stop") : t("actions.run")}
                </Button>
                {!isRunning && (hasMultipleExecutables || (hasExecutables && hasSteamSkus) || steamSkus.length > 1) && (
                    <DropdownMenu>
                        <DropdownMenuTrigger asChild>
                            <Button
                                size="sm"
                                variant="default"
                                className="rounded-l-none border-l border-l-primary-foreground/20 px-1.5"
                                disabled={isLoading}
                            >
                                <ChevronDown className="h-4 w-4" />
                            </Button>
                        </DropdownMenuTrigger>
                        <DropdownMenuContent align="end" className="max-h-60 overflow-y-auto">
                            {win32Executables.map((exe, idx) => (
                                <DropdownMenuItem
                                    key={`exe-${idx}`}
                                    onClick={() => onStart(game, exe.name)}
                                    className="text-xs font-mono cursor-pointer"
                                >
                                    {exe.name}
                                </DropdownMenuItem>
                            ))}
                            {hasExecutables && hasSteamSkus && (
                                <div className="px-2 py-1.5">
                                    <div className="h-px bg-border" />
                                </div>
                            )}
                            {steamSkus.map((sku, idx) => (
                                <DropdownMenuItem
                                    key={`steam-${idx}`}
                                    onClick={() => onStartSteam(game, sku.id)}
                                    className="text-xs cursor-pointer"
                                >
                                    <span className="text-blue-400 mr-1.5">Steam</span> App {sku.id}
                                </DropdownMenuItem>
                            ))}
                        </DropdownMenuContent>
                    </DropdownMenu>
                )}
            </div>
        </div>
    )
}
