package main

type Item struct {
	Name  string
	Price int
	Qty   int
}

func total(items []Item) int {
	sum := 0
	for _, it := range items {
		<|>
	}
	return sum
}
