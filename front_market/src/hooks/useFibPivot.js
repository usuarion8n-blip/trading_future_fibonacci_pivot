/**
 * useFibPivot
 * Fetches the two most recent rows from `fib_pivot_daily` in Supabase.
 * Returns:
 *   levels      → most recent day (yesterday)
 *   prevLevels  → day before yesterday
 */
import { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'

function parseRow(row) {
    return {
        pivot: parseFloat(row.pp),
        r1: parseFloat(row.r1),
        r2: parseFloat(row.r2),
        r3: parseFloat(row.r3),
        s1: parseFloat(row.s1),
        s2: parseFloat(row.s2),
        s3: parseFloat(row.s3),
    }
}

export function useFibPivot() {
    const [levels, setLevels] = useState(null)      // yesterday
    const [prevLevels, setPrevLevels] = useState(null) // day before yesterday
    const [loading, setLoading] = useState(true)
    const [error, setError] = useState(null)

    useEffect(() => {
        async function fetchPivot() {
            setLoading(true)
            setError(null)
            try {
                const { data, error: sbError } = await supabase
                    .from('fib_pivot_daily')
                    .select('pp, r1, r2, r3, s1, s2, s3')
                    .order('run_ts', { ascending: false })
                    .limit(2)

                if (sbError) throw sbError

                if (data && data.length >= 1) {
                    setLevels(parseRow(data[0]))
                }
                if (data && data.length >= 2) {
                    setPrevLevels(parseRow(data[1]))
                }
            } catch (err) {
                console.error('[useFibPivot] Error:', err)
                setError(err)
            } finally {
                setLoading(false)
            }
        }

        fetchPivot()
    }, [])

    return { levels, prevLevels, loading, error }
}
