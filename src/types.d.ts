export type ToWorker = {
    type: "search",
    indexUrl: string
    searchText: string
}

export type ToMain = {
    type: "searchResult",
    result: string[]
}