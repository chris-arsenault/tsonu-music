/**
 * Resolves an authored kernel-input selection against what the compiled graph currently offers.
 *
 * Undefined means automatic membership: every compatible input, including compatible outputs added
 * later. An array is explicit membership, and an empty array deliberately disconnects the stage.
 * Graph order wins over document order so composition and field summation remain deterministic.
 */
export function selectKernelInputs<T extends { id: string }>(
    available: readonly T[],
    selected: readonly string[] | undefined,
): T[] {
    if (selected === undefined) {
        return [...available];
    }

    const included = new Set(selected);
    return available.filter((input) => included.has(input.id));
}
