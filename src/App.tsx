"use client"

import { useState, useEffect, useMemo, useRef, useCallback } from "react"
import { useTranslation } from "react-i18next"
import { invoke } from "@tauri-apps/api/core"
import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { toast } from "sonner"
import { Toaster } from "@/components/ui/sonner"
import { Search, RefreshCw, Gamepad2, Loader2, Star, ListVideo } from "lucide-react"
import { GameCard, type Game } from "@/components/game-card"
import { TitleBar } from "@/components/title-bar"
import {
    PlaylistPanel,
    MAX_PLAYLIST_GAMES,
    DEFAULT_PLAY_DURATION_MINUTES,
    MIN_PLAY_DURATION_MINUTES,
    MAX_PLAY_DURATION_MINUTES,
    DEFAULT_BREAK_INTERVAL_MINUTES,
    MIN_BREAK_INTERVAL_MINUTES,
    MAX_BREAK_INTERVAL_MINUTES,
    type PlaylistPhase,
} from "@/components/playlist-panel"
import { Separator } from "@/components/ui/separator"
import { ScrollArea } from "@/components/ui/scroll-area"
import {
    Pagination,
    PaginationContent,
    PaginationItem,
    PaginationLink,
    PaginationNext,
    PaginationPrevious,
    PaginationEllipsis,
} from "@/components/ui/pagination"

interface FetchGamesResponse {
    games: Game[]
    from_cache: boolean
}

interface PlaylistRunState {
    phase: PlaylistPhase
    currentGameId: string | null
    phaseStartedAt: number | null
    completedIds: string[]
}

const PLAYLIST_STORAGE_KEY = "disactivity_playlist"
const PLAYLIST_PLAY_DURATION_KEY = "disactivity_playlist_play_minutes"
const PLAYLIST_BREAK_INTERVAL_KEY = "disactivity_playlist_break_minutes"

function loadStoredPlaylist(): string[] {
    try {
        const raw = localStorage.getItem(PLAYLIST_STORAGE_KEY)
        if (!raw) return []
        const parsed = JSON.parse(raw)
        if (!Array.isArray(parsed)) return []
        const unique = Array.from(new Set(parsed.filter((item): item is string => typeof item === "string")))
        return unique.slice(0, MAX_PLAYLIST_GAMES)
    } catch {
        return []
    }
}

function loadStoredMinutes(key: string, defaultVal: number, minVal: number, maxVal: number): number {
    try {
        const raw = localStorage.getItem(key)
        if (!raw) return defaultVal
        const parsed = parseInt(raw, 10)
        if (isNaN(parsed)) return defaultVal
        return Math.max(minVal, Math.min(maxVal, parsed))
    } catch {
        return defaultVal
    }
}

const INITIAL_PLAYLIST_RUN: PlaylistRunState = {
    phase: "idle",
    currentGameId: null,
    phaseStartedAt: null,
    completedIds: [],
}

export default function GameLauncher() {
    const { t } = useTranslation()
    const [searchQuery, setSearchQuery] = useState("")
    const [games, setGames] = useState<Game[]>([])
    const [filteredGames, setFilteredGames] = useState<Game[]>([])
    const [currentPage, setCurrentPage] = useState(1)
    const [isLoading, setIsLoading] = useState(true)
    const [isRefreshing, setIsRefreshing] = useState(false)
    const [runningGames, setRunningGames] = useState<Set<string>>(new Set())
    const [loadingGames, setLoadingGames] = useState<Set<string>>(new Set())
    const [favorites, setFavorites] = useState<Set<string>>(new Set())
    const [gameStartTimes, setGameStartTimes] = useState<Map<string, number>>(new Map())

    // Playlist state
    const [playlistIds, setPlaylistIds] = useState<string[]>(() => loadStoredPlaylist())
    const [playDurationMinutes, setPlayDurationMinutes] = useState<number>(() =>
        loadStoredMinutes(
            PLAYLIST_PLAY_DURATION_KEY,
            DEFAULT_PLAY_DURATION_MINUTES,
            MIN_PLAY_DURATION_MINUTES,
            MAX_PLAY_DURATION_MINUTES
        )
    )
    const [breakIntervalMinutes, setBreakIntervalMinutes] = useState<number>(() =>
        loadStoredMinutes(
            PLAYLIST_BREAK_INTERVAL_KEY,
            DEFAULT_BREAK_INTERVAL_MINUTES,
            MIN_BREAK_INTERVAL_MINUTES,
            MAX_BREAK_INTERVAL_MINUTES
        )
    )
    const [isPlaylistOpen, setIsPlaylistOpen] = useState<boolean>(() => loadStoredPlaylist().length > 0)
    const [playlistRun, setPlaylistRun] = useState<PlaylistRunState>(INITIAL_PLAYLIST_RUN)

    // Refs to keep async playlist transitions free of stale closures
    const gamesRef = useRef<Game[]>(games)
    const playlistIdsRef = useRef<string[]>(playlistIds)
    const runningGamesRef = useRef<Set<string>>(runningGames)
    const playlistRunRef = useRef<PlaylistRunState>(playlistRun)
    const playDurationRef = useRef<number>(playDurationMinutes)
    const breakIntervalRef = useRef<number>(breakIntervalMinutes)
    const isTransitioningRef = useRef<boolean>(false)
    const playlistSessionRef = useRef<number>(0)

    gamesRef.current = games
    playlistIdsRef.current = playlistIds
    runningGamesRef.current = runningGames
    playlistRunRef.current = playlistRun
    playDurationRef.current = playDurationMinutes
    breakIntervalRef.current = breakIntervalMinutes

    const ITEMS_PER_PAGE = 50

    useEffect(() => {
        try {
            localStorage.setItem(PLAYLIST_STORAGE_KEY, JSON.stringify(playlistIds))
        } catch (error) {
            console.error("Failed to persist playlist:", error)
        }
    }, [playlistIds])

    useEffect(() => {
        try {
            localStorage.setItem(PLAYLIST_PLAY_DURATION_KEY, String(playDurationMinutes))
        } catch (error) {
            console.error("Failed to persist play duration:", error)
        }
    }, [playDurationMinutes])

    useEffect(() => {
        try {
            localStorage.setItem(PLAYLIST_BREAK_INTERVAL_KEY, String(breakIntervalMinutes))
        } catch (error) {
            console.error("Failed to persist break interval:", error)
        }
    }, [breakIntervalMinutes])

    const fetchGames = async (forceRefresh: boolean = false) => {
        try {
            if (forceRefresh) {
                setIsRefreshing(true)
            } else {
                setIsLoading(true)
            }

            const response = await invoke<FetchGamesResponse>("fetch_games", { forceRefresh })
            setGames(response.games)
            setFilteredGames(response.games)
            setCurrentPage(1)

            if (forceRefresh) {
                toast.success(t("toast.refreshed.title"), {
                    description: t("toast.refreshed.description", { count: response.games.length }),
                })
            } else if (response.from_cache) {
                toast.info(t("toast.loadedFromCache.title"), {
                    description: t("toast.loadedFromCache.description", { count: response.games.length }),
                })
            }
        } catch (error) {
            toast.error(t("toast.error.title"), {
                description: t("toast.error.fetchFailed", { error }),
            })
        } finally {
            setIsLoading(false)
            setIsRefreshing(false)
        }
    }

    const fetchFavorites = async () => {
        try {
            const favs = await invoke<string[]>("get_favorites")
            setFavorites(new Set(favs))
        } catch (error) {
            console.error("Failed to load favorites:", error)
        }
    }

    useEffect(() => {
        fetchGames().catch(console.error)
        fetchFavorites().catch(console.error)
    }, [])

    useEffect(() => {
        const terms = searchQuery
            .toLowerCase()
            .split(",")
            .map((term) => term.trim())
            .filter(Boolean)

        setCurrentPage(1)

        if (terms.length === 0) {
            setFilteredGames(games)
            return
        }

        const results = games.filter((game) => {
            const gameName = game.name.toLowerCase()
            const gameId = game.id.toLowerCase()
            const gameAliases = game.aliases?.map((alias) => alias.toLowerCase()) || []

            return terms.some((term) => {
                if (gameName.includes(term)) return true
                if (gameId.includes(term)) return true
                return gameAliases.some((alias) => alias.includes(term))
            })
        })

        setFilteredGames(results)
    }, [searchQuery, games])

    const handleRefresh = () => {
        setSearchQuery("")
        fetchGames(true).catch(console.error)
    }

    const startGameInternal = useCallback(
        async (game: Game, selectedExecutable?: string, options?: { silent?: boolean }): Promise<boolean> => {
            const steamSku = game.third_party_skus?.find((sku) => sku.distributor === "steam")
            const steamAppId = Number(steamSku?.id || steamSku?.sku)
            const useSteam =
                selectedExecutable === "__steam__" ||
                !game.executables?.some((exe) => exe.os === "win32" && !exe.name.startsWith(">"))
            if (useSteam && (!steamAppId || !Number.isSafeInteger(steamAppId))) {
                if (!options?.silent) {
                    toast.error(t("toast.cannotStartGame.title"), {
                        description: t("toast.cannotStartGame.noExecutables"),
                    })
                }
                return false
            }

            setLoadingGames((prev) => new Set(prev).add(game.id))

            try {
                const startResult = await invoke<{ needs_discord_restart: boolean }>("start_game", {
                    gameId: game.id,
                    executables: game.executables || [],
                    selectedExecutable: selectedExecutable && selectedExecutable !== "__steam__" ? selectedExecutable : null,
                    steamAppId: useSteam ? steamAppId : null,
                    gameName: game.name,
                })

                const startedAt = Date.now()
                setRunningGames((prev) => new Set(prev).add(game.id))
                setGameStartTimes((prev) => new Map(prev).set(game.id, startedAt))

                if (!options?.silent) {
                    toast.success(t("toast.gameStarted.title"), {
                        description: t("toast.gameStarted.description", { name: game.name }),
                    })
                }
                if (useSteam && startResult.needs_discord_restart) {
                    toast.info(t("toast.steamRestart.title"), {
                        description: t("toast.steamRestart.description"),
                        duration: 10000,
                    })
                }
                return true
            } catch (error) {
                if (!options?.silent) {
                    toast.error(t("toast.failedToStartGame.title"), {
                        description: `${error}`,
                    })
                }
                return false
            } finally {
                setLoadingGames((prev) => {
                    const next = new Set(prev)
                    next.delete(game.id)
                    return next
                })
            }
        },
        [t]
    )

    const stopGameInternal = useCallback(
        async (gameId: string, options?: { silent?: boolean }): Promise<boolean> => {
            const game = gamesRef.current.find((g) => g.id === gameId)
            setLoadingGames((prev) => new Set(prev).add(gameId))

            try {
                await invoke("stop_game", { gameId })

                setRunningGames((prev) => {
                    const next = new Set(prev)
                    next.delete(gameId)
                    return next
                })
                setGameStartTimes((prev) => {
                    const next = new Map(prev)
                    next.delete(gameId)
                    return next
                })
                if (!options?.silent) {
                    toast.success(t("toast.gameStopped.title"), {
                        description: t("toast.gameStopped.description", { name: game?.name || "Game" }),
                    })
                }
                return true
            } catch (error) {
                if (!options?.silent) {
                    toast.error(t("toast.failedToStopGame.title"), {
                        description: `${error}`,
                    })
                }
                return false
            } finally {
                setLoadingGames((prev) => {
                    const next = new Set(prev)
                    next.delete(gameId)
                    return next
                })
            }
        },
        [t]
    )

    const handleStartGame = async (game: Game, selectedExecutable?: string) => {
        await startGameInternal(game, selectedExecutable)
    }

    const handleStopGame = async (gameId: string) => {
        if (playlistRunRef.current.phase === "playing" && playlistRunRef.current.currentGameId === gameId) {
            playlistSessionRef.current += 1
            setPlaylistRun(INITIAL_PLAYLIST_RUN)
        }
        await stopGameInternal(gameId)
    }

    const startPlaylistFromIndex = useCallback(
        async (
            startIndex: number,
            sessionId: number,
            completedIds: string[],
            options?: { isInitialStart?: boolean; queueIds?: string[] }
        ) => {
            const queueIds = options?.queueIds ?? playlistIdsRef.current
            const validQueueGames = queueIds
                .map((id) => gamesRef.current.find((g) => g.id === id))
                .filter((g): g is Game => Boolean(g))

            for (let idx = startIndex; idx < validQueueGames.length; idx++) {
                if (playlistSessionRef.current !== sessionId) {
                    return
                }

                const game = validQueueGames[idx]
                const alreadyRunning = runningGamesRef.current.has(game.id)
                let started = alreadyRunning

                if (!alreadyRunning) {
                    started = await startGameInternal(game, undefined, { silent: true })
                }

                // If user stopped the playlist while start_game was in flight, clean up the process we just spawned
                if (playlistSessionRef.current !== sessionId) {
                    if (!alreadyRunning && started) {
                        await stopGameInternal(game.id, { silent: true })
                    }
                    return
                }

                if (started) {
                    const startedAt = Date.now()
                    setGameStartTimes((prev) => new Map(prev).set(game.id, startedAt))
                    setPlaylistRun({
                        phase: "playing",
                        currentGameId: game.id,
                        phaseStartedAt: startedAt,
                        completedIds,
                    })

                    if (options?.isInitialStart && idx === startIndex) {
                        toast.success(t("toast.playlistStarted.title"), {
                            description: t("toast.playlistStarted.description", {
                                count: validQueueGames.length,
                                playMinutes: playDurationRef.current,
                                breakMinutes: breakIntervalRef.current,
                            }),
                        })
                    } else {
                        toast.info(t("toast.playlistNext.title"), {
                            description: t("toast.playlistNext.description", {
                                name: game.name,
                                current: idx + 1,
                                total: validQueueGames.length,
                            }),
                        })
                    }
                    return
                }

                toast.warning(t("toast.playlistSkippedError.title"), {
                    description: t("toast.playlistSkippedError.description", { name: game.name }),
                })
            }

            if (playlistSessionRef.current !== sessionId) {
                return
            }

            setPlaylistRun({
                phase: "idle",
                currentGameId: null,
                phaseStartedAt: null,
                completedIds,
            })

            if (completedIds.length > 0 || !options?.isInitialStart) {
                toast.success(t("toast.playlistCompleted.title"), {
                    description: t("toast.playlistCompleted.description", { count: validQueueGames.length }),
                })
            }
        },
        [startGameInternal, stopGameInternal, t]
    )

    const advancePlaylist = useCallback(
        async (options?: { skipBreak?: boolean }) => {
            if (isTransitioningRef.current || playlistRunRef.current.phase === "idle") return
            isTransitioningRef.current = true
            const sessionId = playlistSessionRef.current

            try {
                const { phase, currentGameId, completedIds } = playlistRunRef.current
                const validGames = playlistIdsRef.current
                    .map((id) => gamesRef.current.find((g) => g.id === id))
                    .filter((g): g is Game => Boolean(g))
                const currentIdx = currentGameId ? validGames.findIndex((g) => g.id === currentGameId) : -1

                // If currently on break, start the upcoming game immediately
                if (phase === "break") {
                    const startIdx = currentIdx >= 0 ? currentIdx : 0
                    await startPlaylistFromIndex(startIdx, sessionId, completedIds)
                    return
                }

                // Currently playing: stop current game first
                if (currentGameId && runningGamesRef.current.has(currentGameId)) {
                    await stopGameInternal(currentGameId, { silent: true })
                }

                if (playlistSessionRef.current !== sessionId) {
                    return
                }

                const updatedCompleted =
                    currentGameId && !completedIds.includes(currentGameId)
                        ? [...completedIds, currentGameId]
                        : completedIds

                const nextIdx = currentIdx + 1
                if (nextIdx >= validGames.length) {
                    setPlaylistRun({
                        phase: "idle",
                        currentGameId: null,
                        phaseStartedAt: null,
                        completedIds: updatedCompleted,
                    })
                    toast.success(t("toast.playlistCompleted.title"), {
                        description: t("toast.playlistCompleted.description", { count: validGames.length }),
                    })
                    return
                }

                // Enter break phase if break interval > 0 and user did not manually skip
                if (!options?.skipBreak && breakIntervalRef.current > 0) {
                    const nextGame = validGames[nextIdx]
                    setPlaylistRun({
                        phase: "break",
                        currentGameId: nextGame.id,
                        phaseStartedAt: Date.now(),
                        completedIds: updatedCompleted,
                    })
                    toast.info(t("toast.playlistBreak.title"), {
                        description: t("toast.playlistBreak.description", {
                            minutes: breakIntervalRef.current,
                            name: nextGame.name,
                        }),
                    })
                    return
                }

                await startPlaylistFromIndex(nextIdx, sessionId, updatedCompleted)
            } finally {
                isTransitioningRef.current = false
            }
        },
        [startPlaylistFromIndex, stopGameInternal, t]
    )

    const handleStartPlaylist = async () => {
        if (isTransitioningRef.current) return
        const validIds = playlistIdsRef.current.filter((id) => gamesRef.current.some((g) => g.id === id))
        if (validIds.length === 0) return

        isTransitioningRef.current = true
        const sessionId = ++playlistSessionRef.current

        try {
            await startPlaylistFromIndex(0, sessionId, [], { isInitialStart: true, queueIds: validIds })
        } finally {
            isTransitioningRef.current = false
        }
    }

    const handleStopPlaylist = async () => {
        playlistSessionRef.current += 1
        const { phase, currentGameId } = playlistRunRef.current
        setPlaylistRun(INITIAL_PLAYLIST_RUN)

        if (phase === "playing" && currentGameId && runningGamesRef.current.has(currentGameId)) {
            await stopGameInternal(currentGameId, { silent: true })
        }

        toast.info(t("toast.playlistStopped.title"), {
            description: t("toast.playlistStopped.description"),
        })
    }

    const handleSkipPlaylistGame = () => {
        advancePlaylist({ skipBreak: true }).catch(console.error)
    }

    const handleTogglePlaylistGame = (gameId: string) => {
        const game = games.find((g) => g.id === gameId)

        if (playlistIds.includes(gameId)) {
            handleRemoveFromPlaylist(gameId)
            return
        }

        if (playlistIds.length >= MAX_PLAYLIST_GAMES) {
            toast.warning(t("toast.playlistFull.title"), {
                description: t("toast.playlistFull.description", { max: MAX_PLAYLIST_GAMES }),
            })
            return
        }

        setPlaylistIds((prev) => [...prev, gameId])
        if (playlistIds.length === 0) {
            setIsPlaylistOpen(true)
        }
        toast.success(t("toast.addedToPlaylist.title"), {
            description: game?.name || gameId,
        })
    }

    const handleRemoveFromPlaylist = (gameId: string) => {
        const game = games.find((g) => g.id === gameId)
        const prevValidIds = playlistIdsRef.current.filter((id) => gamesRef.current.some((g) => g.id === id))
        const removedValidIndex = prevValidIds.indexOf(gameId)
        const nextIds = playlistIdsRef.current.filter((id) => id !== gameId)

        setPlaylistIds(nextIds)
        toast.info(t("toast.removedFromPlaylist.title"), {
            description: game?.name || gameId,
        })

        const { phase, currentGameId, phaseStartedAt, completedIds } = playlistRunRef.current
        if (phase === "idle" || currentGameId !== gameId) {
            return
        }

        const remainingValid = nextIds.filter((id) => gamesRef.current.some((g) => g.id === id))
        const filteredCompleted = completedIds.filter((id) => id !== gameId)

        if (phase === "break") {
            if (removedValidIndex < remainingValid.length && remainingValid.length > 0) {
                setPlaylistRun({
                    phase: "break",
                    currentGameId: remainingValid[removedValidIndex],
                    phaseStartedAt,
                    completedIds: filteredCompleted,
                })
            } else {
                playlistSessionRef.current += 1
                setPlaylistRun(INITIAL_PLAYLIST_RUN)
            }
            return
        }

        // Removed currently playing game: stop it and advance to the next remaining game
        const sessionId = ++playlistSessionRef.current
        ;(async () => {
            isTransitioningRef.current = true
            try {
                if (runningGamesRef.current.has(gameId)) {
                    await stopGameInternal(gameId, { silent: true })
                }
                if (playlistSessionRef.current !== sessionId) return
                if (remainingValid.length === 0 || removedValidIndex >= remainingValid.length) {
                    setPlaylistRun(INITIAL_PLAYLIST_RUN)
                    return
                }
                await startPlaylistFromIndex(removedValidIndex, sessionId, filteredCompleted, {
                    queueIds: remainingValid,
                })
            } finally {
                isTransitioningRef.current = false
            }
        })().catch(console.error)
    }

    const handleClearPlaylist = () => {
        if (playlistRunRef.current.phase !== "idle") return
        setPlaylistIds([])
        setPlaylistRun(INITIAL_PLAYLIST_RUN)
    }

    const handleMovePlaylistItem = (index: number, direction: -1 | 1) => {
        setPlaylistIds((prev) => {
            const validIds = prev.filter((id) => gamesRef.current.some((g) => g.id === id))
            const targetIndex = index + direction
            if (index < 0 || targetIndex < 0 || index >= validIds.length || targetIndex >= validIds.length) {
                return prev
            }
            const next = [...validIds]
            ;[next[index], next[targetIndex]] = [next[targetIndex], next[index]]
            return next
        })
    }

    // Automatic timer to transition between playing and break phases
    useEffect(() => {
        if (playlistRun.phase === "idle" || !playlistRun.phaseStartedAt) return

        const interval = setInterval(() => {
            const { phase, phaseStartedAt } = playlistRunRef.current
            if (phase === "idle" || !phaseStartedAt || isTransitioningRef.current) return
            const targetMs =
                (phase === "break" ? breakIntervalRef.current : playDurationRef.current) * 60 * 1000
            if (Date.now() - phaseStartedAt >= targetMs) {
                advancePlaylist().catch(console.error)
            }
        }, 1000)

        return () => clearInterval(interval)
    }, [playlistRun.phase, playlistRun.phaseStartedAt, advancePlaylist])

    const handleToggleFavorite = async (gameId: string) => {
        try {
            const isFavorite = await invoke<boolean>("toggle_favorite", { gameId })
            setFavorites((prev) => {
                const next = new Set(prev)
                if (isFavorite) {
                    next.add(gameId)
                } else {
                    next.delete(gameId)
                }
                return next
            })
            const game = games.find((g) => g.id === gameId)
            toast.success(isFavorite ? t("toast.addedToFavorites.title") : t("toast.removedFromFavorites.title"), {
                description: game?.name || gameId,
            })
        } catch (error) {
            toast.error(t("toast.failedToUpdateFavorites.title"), {
                description: `${error}`,
            })
        }
    }

    // Resolve playlist Game objects in queue order
    const playlistGames = useMemo(() => {
        const gameMap = new Map(games.map((g) => [g.id, g]))
        return playlistIds.map((id) => gameMap.get(id)).filter((g): g is Game => Boolean(g))
    }, [games, playlistIds])

    const playlistIndexMap = useMemo(() => {
        const map = new Map<string, number>()
        playlistGames.forEach((game, idx) => map.set(game.id, idx))
        return map
    }, [playlistGames])

    const completedPlaylistIds = useMemo(() => new Set(playlistRun.completedIds), [playlistRun.completedIds])
    const isPlaylistFull = playlistGames.length >= MAX_PLAYLIST_GAMES
    const isPlaylistActive = playlistRun.phase !== "idle"
    const playlistTargetMs = playDurationMinutes * 60 * 1000

    // Separate favorites and non-favorites from filtered games
    const { favoriteGames, nonFavoriteGames } = useMemo(() => {
        const favs = filteredGames.filter((game) => favorites.has(game.id))
        const nonFavs = filteredGames.filter((game) => !favorites.has(game.id))
        return { favoriteGames: favs, nonFavoriteGames: nonFavs }
    }, [filteredGames, favorites])

    // Pagination only applies to non-favorite games
    const totalPages = Math.ceil(nonFavoriteGames.length / ITEMS_PER_PAGE)
    const paginatedGames = useMemo(() => {
        const startIndex = (currentPage - 1) * ITEMS_PER_PAGE
        return nonFavoriteGames.slice(startIndex, startIndex + ITEMS_PER_PAGE)
    }, [nonFavoriteGames, currentPage])

    const goToPage = (page: number) => {
        const validPage = Math.max(1, Math.min(totalPages, page))
        setCurrentPage(validPage)
        // Scroll to top of the game list
        window.scrollTo({ top: 0, behavior: 'smooth' })
    }

    const getPageNumbers = () => {
        const pages: (number | "ellipsis")[] = []
        if (totalPages <= 7) {
            for (let i = 1; i <= totalPages; i++) pages.push(i)
        } else {
            pages.push(1)
            if (currentPage > 3) pages.push("ellipsis")
            for (let i = Math.max(2, currentPage - 1); i <= Math.min(totalPages - 1, currentPage + 1); i++) {
                pages.push(i)
            }
            if (currentPage < totalPages - 2) pages.push("ellipsis")
            pages.push(totalPages)
        }
        return pages
    }

    // Create a map of running games info for the TitleBar task manager
    const runningGamesInfo = useMemo(() => {
        const map = new Map<string, { game: Game; isLoading: boolean; startTime: number; targetDurationMs?: number }>()
        runningGames.forEach((gameId) => {
            const game = games.find((g) => g.id === gameId)
            if (game) {
                map.set(gameId, {
                    game,
                    isLoading: loadingGames.has(gameId),
                    startTime: gameStartTimes.get(gameId) || Date.now(),
                    targetDurationMs:
                        playlistRun.phase === "playing" && playlistRun.currentGameId === gameId
                            ? playlistTargetMs
                            : undefined,
                })
            }
        })
        return map
    }, [runningGames, loadingGames, games, gameStartTimes, playlistRun.phase, playlistRun.currentGameId, playlistTargetMs])

    return (
        <div className="h-screen flex flex-col bg-background/90 dark:bg-background/80 backdrop-blur-xl font-sans antialiased overflow-hidden">
            <TitleBar runningGames={runningGamesInfo} onStopGame={handleStopGame} />

            <ScrollArea className="flex-1 mt-10">
                <main className="mx-5 pb-5 overflow-hidden max-sm:mx-2 max-sm:pb-3">
                    <div className="container mx-auto px-4 py-6 max-w-4xl overflow-hidden max-sm:px-2 max-sm:py-4">

                    {/* Search Bar */}
                    <div className="flex gap-2 mb-6 max-sm:gap-1.5 max-sm:flex-wrap">
                        <div className="relative flex-1">
                            <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-muted-foreground" />
                            <Input
                                type="text"
                                placeholder={t("search.placeholder")}
                                value={searchQuery}
                                onChange={(e) => setSearchQuery(e.target.value)}
                                className="pl-10 bg-background max-sm:h-9 max-sm:text-xs"
                                disabled={isLoading}
                            />
                        </div>
                        <Button
                            variant={isPlaylistOpen ? "secondary" : "outline"}
                            onClick={() => setIsPlaylistOpen((prev) => !prev)}
                            disabled={isLoading}
                            className="bg-background whitespace-nowrap max-sm:h-9 max-sm:px-2 max-sm:text-xs"
                        >
                            <ListVideo
                                className={`h-4 w-4 mr-1.5 ${
                                    playlistRun.phase === "playing"
                                        ? "text-green-500"
                                        : playlistRun.phase === "break"
                                            ? "text-amber-500"
                                            : ""
                                }`}
                            />
                            {t("playlist.toggle")}
                            <span className="ml-1 text-xs text-muted-foreground">
                                ({playlistGames.length}/{MAX_PLAYLIST_GAMES})
                            </span>
                            {isPlaylistActive && (
                                <span
                                    className={`ml-1.5 h-2 w-2 rounded-full animate-pulse ${
                                        playlistRun.phase === "break" ? "bg-amber-500" : "bg-green-500"
                                    }`}
                                />
                            )}
                        </Button>
                        <Button variant="outline" onClick={handleRefresh} disabled={isLoading || isRefreshing} className="bg-background whitespace-nowrap max-sm:h-9 max-sm:px-2 max-sm:text-xs">
                            {isRefreshing ? (
                                <Loader2 className="h-4 w-4 mr-2 animate-spin" />
                            ) : (
                                <RefreshCw className="h-4 w-4 mr-2" />
                            )}
                            {t("actions.refresh")}
                        </Button>
                    </div>

                    {/* Loading State */}
                    {isLoading ? (
                        <div className="flex flex-col items-center justify-center py-20">
                            <Loader2 className="h-12 w-12 animate-spin text-primary mb-4" />
                            <p className="text-muted-foreground">{t("loading.games")}</p>
                        </div>
                    ) : (
                        <>
                            {/* Playlist Section */}
                            {isPlaylistOpen && (
                                <>
                                    <PlaylistPanel
                                        games={playlistGames}
                                        playDurationMinutes={playDurationMinutes}
                                        breakIntervalMinutes={breakIntervalMinutes}
                                        phase={playlistRun.phase}
                                        currentGameId={playlistRun.currentGameId}
                                        phaseStartedAt={playlistRun.phaseStartedAt}
                                        completedIds={completedPlaylistIds}
                                        loadingGames={loadingGames}
                                        onPlayDurationChange={setPlayDurationMinutes}
                                        onBreakIntervalChange={setBreakIntervalMinutes}
                                        onStart={handleStartPlaylist}
                                        onStop={handleStopPlaylist}
                                        onSkip={handleSkipPlaylistGame}
                                        onClear={handleClearPlaylist}
                                        onRemove={handleRemoveFromPlaylist}
                                        onMove={handleMovePlaylistItem}
                                    />
                                    <Separator className="my-4" />
                                </>
                            )}

                            {/* Favorites Section */}
                            {favoriteGames.length > 0 && (
                                <div className="mb-4">
                                    <div className="flex items-center gap-2 mb-2">
                                        <Star className="h-4 w-4 text-yellow-500 fill-yellow-500" />
                                        <h2 className="text-sm font-semibold text-foreground">{t("favorites.title")}</h2>
                                        <span className="text-xs text-muted-foreground">({favoriteGames.length})</span>
                                    </div>
                                    <div className="space-y-1">
                                        {favoriteGames.map((game) => (
                                            <GameCard
                                                key={game.id}
                                                game={game}
                                                isRunning={runningGames.has(game.id)}
                                                isLoading={loadingGames.has(game.id)}
                                                isFavorite={true}
                                                isInPlaylist={playlistIndexMap.has(game.id)}
                                                playlistIndex={playlistIndexMap.get(game.id)}
                                                isPlaylistFull={isPlaylistFull}
                                                maxPlaylistGames={MAX_PLAYLIST_GAMES}
                                                startTime={gameStartTimes.get(game.id)}
                                                targetDurationMs={
                                                    playlistRun.phase === "playing" && playlistRun.currentGameId === game.id
                                                        ? playlistTargetMs
                                                        : undefined
                                                }
                                                onStart={handleStartGame}
                                                onStop={handleStopGame}
                                                onToggleFavorite={handleToggleFavorite}
                                                onTogglePlaylist={handleTogglePlaylistGame}
                                            />
                                        ))}
                                    </div>
                                    <Separator className="my-4" />
                                </div>
                            )}

                            {/* Game list */}
                            <div className="space-y-1">
                                {paginatedGames.length > 0 ? (
                                    paginatedGames.map((game) => (
                                        <GameCard
                                            key={game.id}
                                            game={game}
                                            isRunning={runningGames.has(game.id)}
                                            isLoading={loadingGames.has(game.id)}
                                            isFavorite={favorites.has(game.id)}
                                            isInPlaylist={playlistIndexMap.has(game.id)}
                                            playlistIndex={playlistIndexMap.get(game.id)}
                                            isPlaylistFull={isPlaylistFull}
                                            maxPlaylistGames={MAX_PLAYLIST_GAMES}
                                            startTime={gameStartTimes.get(game.id)}
                                            targetDurationMs={
                                                playlistRun.phase === "playing" && playlistRun.currentGameId === game.id
                                                    ? playlistTargetMs
                                                    : undefined
                                            }
                                            onStart={handleStartGame}
                                            onStop={handleStopGame}
                                            onToggleFavorite={handleToggleFavorite}
                                            onTogglePlaylist={handleTogglePlaylistGame}
                                        />
                                    ))
                                ) : filteredGames.length === 0 ? (
                                    <div className="text-center py-12 text-muted-foreground">
                                        <Gamepad2 className="h-12 w-12 mx-auto mb-4 opacity-50" />
                                        <p>{t("emptyState.noGamesFound")}</p>
                                    </div>
                                ) : null}
                            </div>

                            {totalPages > 1 && (
                                <div className="mt-6 space-y-4">
                                    <Pagination>
                                        <PaginationContent>
                                            <PaginationItem>
                                                <PaginationPrevious
                                                    href="#"
                                                    onClick={(e) => {
                                                        e.preventDefault()
                                                        goToPage(currentPage - 1)
                                                    }}
                                                    className={currentPage === 1 ? "pointer-events-none opacity-50" : "cursor-pointer"}
                                                />
                                            </PaginationItem>
                                            {getPageNumbers().map((page, index) =>
                                                page === "ellipsis" ? (
                                                    <PaginationItem key={`ellipsis-${index}`}>
                                                        <PaginationEllipsis />
                                                    </PaginationItem>
                                                ) : (
                                                    <PaginationItem key={page}>
                                                        <PaginationLink
                                                            href="#"
                                                            onClick={(e) => {
                                                                e.preventDefault()
                                                                goToPage(page)
                                                            }}
                                                            isActive={currentPage === page}
                                                            className="cursor-pointer"
                                                        >
                                                            {page}
                                                        </PaginationLink>
                                                    </PaginationItem>
                                                ),
                                            )}
                                            <PaginationItem>
                                                <PaginationNext
                                                    href="#"
                                                    onClick={(e) => {
                                                        e.preventDefault()
                                                        goToPage(currentPage + 1)
                                                    }}
                                                    className={currentPage === totalPages ? "pointer-events-none opacity-50" : "cursor-pointer"}
                                                />
                                            </PaginationItem>
                                        </PaginationContent>
                                    </Pagination>

                                    {/* Page Jump */}
                                    <div className="flex items-center justify-center gap-2 text-sm max-sm:flex-wrap max-sm:text-xs">
                                        <span className="text-muted-foreground">{t("pagination.goToPage")}</span>
                                        <Input
                                            type="number"
                                            min={1}
                                            max={totalPages}
                                            className="w-16 h-8 text-center max-sm:h-7 max-sm:w-14 max-sm:text-xs"
                                            onKeyDown={(e) => {
                                                if (e.key === "Enter") {
                                                    const value = parseInt((e.target as HTMLInputElement).value)
                                                    if (!isNaN(value)) {
                                                        goToPage(value)
                                                        ;(e.target as HTMLInputElement).value = ""
                                                    }
                                                }
                                            }}
                                        />
                                        <span className="text-muted-foreground">{t("pagination.of")} {totalPages}</span>
                                    </div>
                                </div>
                            )}

                            {/* Footer */}
                            <div className="mt-4 text-center text-sm text-muted-foreground wrap-break-word max-sm:text-xs">
                                {filteredGames.length > 0 ? (
                                    <>
                                        {favoriteGames.length > 0 && (
                                            <span>{favoriteGames.length} {favoriteGames.length !== 1 ? t("footer.favorites") : t("footer.favorite")} • </span>
                                        )}
                                        {t("footer.showing")} {nonFavoriteGames.length > 0 ? ((currentPage - 1) * ITEMS_PER_PAGE) + 1 : 0}-{Math.min(currentPage * ITEMS_PER_PAGE, nonFavoriteGames.length)} {t("pagination.of")} {nonFavoriteGames.length} {nonFavoriteGames.length !== 1 ? t("footer.games") : t("footer.game")}
                                        {totalPages > 1 && ` (${t("footer.page")} ${currentPage} ${t("pagination.of")} ${totalPages})`}
                                    </>
                                ) : (
                                    <>{t("footer.noGames")}</>
                                )}

                                <p>
                                    Copyright © 2026 holasoyender
                                </p>
                            </div>
                        </>
                    )}
                </div>
            </main>
            </ScrollArea>
            <Toaster />
        </div>
    )
}
