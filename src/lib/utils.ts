import { clsx, type ClassValue } from 'clsx'
import { twMerge } from 'tailwind-merge'
export function cn(...inputs: ClassValue[]) { return twMerge(clsx(inputs)) }
export function errorMessage(error: unknown) { return error instanceof Error ? error.message : String(error) }
export function factLine(kind: string, date: string, place: string) { return [kind[0]?.toUpperCase() + kind.slice(1), date, place && `in ${place}`].filter(Boolean).join(' · ') }
