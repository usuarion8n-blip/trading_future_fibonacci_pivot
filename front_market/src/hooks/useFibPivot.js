/**
 * useFibPivot
 * Fetches the most recent row from `fib_pivot_daily` in Supabase
 * and returns pivot, resistance (R1-R3) and support (S1-S3) levels.
 */
import { useState, useEffect } from 'react'
import { supabase } from '../supabaseClient'

export function useFibPivot() {
    const [levels, setLevels] = useState(null)   // { pivot, r1, r2, r3, s1, s2, s3 }
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
                    .limit(1)
                    .single()

                if (sbError) throw sbError

                setLevels({
                    pivot: parseFloat(data.pp),
                    r1: parseFloat(data.r1),
                    r2: parseFloat(data.r2),
                    r3: parseFloat(data.r3),
                    s1: parseFloat(data.s1),
                    s2: parseFloat(data.s2),
                    s3: parseFloat(data.s3),
                })
            } catch (err) {
                console.error('[useFibPivot] Error:', err)
                setError(err)
            } finally {
                setLoading(false)
            }
        }

        fetchPivot()
    }, [])

    return { levels, loading, error }
}
