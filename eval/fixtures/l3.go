package main

type Alarm struct {
	ID       string
	Machine  string
	Severity int
}

// worst returns the alarm with the highest severity, and false if there are none.
func worst(alarms []Alarm) (Alarm, bool) {
	if len(alarms) == 0 {
		return Alarm{}, false
	}
	<|>
}
