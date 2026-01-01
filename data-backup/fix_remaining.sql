DO $$
DECLARE
    ids INT[] := ARRAY[72,77,80,162,2834,2838,2839,3466,3543,157218,195361,378,1759,1760,1764,1775,1900,1904,1905,3143,3643,3644,169825,214935,1629,2191,2509,2586,2683,2684,2691,2705];
    id INT;
    name TEXT;
    fixed_count INT := 0;
    failed_count INT := 0;
BEGIN
    FOREACH id IN ARRAY ids LOOP
        SELECT unit_nm INTO name FROM public_lands WHERE objectid = id;
        RAISE NOTICE 'Fixing % - %', id, COALESCE(name, 'unnamed');
        
        BEGIN
            -- Try subdivide approach
            WITH parts AS (
                SELECT (ST_Dump(ST_Subdivide(geom, 256))).geom AS g
                FROM public_lands
                WHERE objectid = id
            ),
            fixed AS (
                SELECT ST_MakeValid(g) AS g FROM parts
            )
            UPDATE public_lands t
            SET geom = (SELECT ST_UnaryUnion(ST_Collect(g)) FROM fixed)
            WHERE t.objectid = id;
            
            fixed_count := fixed_count + 1;
            RAISE NOTICE '  ✓ Fixed with subdivide';
        EXCEPTION WHEN OTHERS THEN
            -- Try buffer approach as fallback
            BEGIN
                UPDATE public_lands SET geom = ST_Buffer(ST_Buffer(geom, 0.0001), -0.0001) WHERE objectid = id;
                fixed_count := fixed_count + 1;
                RAISE NOTICE '  ✓ Fixed with buffer';
            EXCEPTION WHEN OTHERS THEN
                failed_count := failed_count + 1;
                RAISE NOTICE '  ✗ Could not fix: %', SQLERRM;
            END;
        END;
    END LOOP;
    
    RAISE NOTICE '';
    RAISE NOTICE 'Summary: % fixed, % failed', fixed_count, failed_count;
END $$;

-- Check remaining
SELECT COUNT(*) as remaining_invalid FROM public_lands WHERE NOT ST_IsValid(geom);
