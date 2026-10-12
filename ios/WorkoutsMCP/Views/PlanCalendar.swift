// The dashboard's calendar, phone-sized: Monday-to-Sunday weeks, a sport icon a workout, and
// a tap picks the day the Planned tab lists underneath. See src/client/components/Calendar.tsx.

import SwiftUI

struct PlanCalendar: View {
    let days: [Date]
    let workouts: [PlannedWorkout]
    @Binding var selected: Date

    private static let weekdays = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"]
    private let columns = Array(repeating: GridItem(.flexible(), spacing: 4), count: 7)

    var body: some View {
        let byDate = Dictionary(grouping: workouts, by: \.date)

        LazyVGrid(columns: columns, spacing: 6) {
            ForEach(Self.weekdays, id: \.self) { weekday in
                Text(weekday).font(.caption2).foregroundStyle(.secondary)
            }
            ForEach(days, id: \.self) { day in
                DayCell(
                    day: day,
                    workouts: byDate[WorkoutDate.string(day)] ?? [],
                    isSelected: Calendar.current.isDate(day, inSameDayAs: selected)
                )
                .onTapGesture { selected = day }
            }
        }
        .padding(.vertical, 6)
    }
}

private struct DayCell: View {
    let day: Date
    let workouts: [PlannedWorkout]
    let isSelected: Bool

    private var isToday: Bool { Calendar.current.isDateInToday(day) }
    /// Behind and not done: on the watch still, and a decision to make.
    private var isMissed: Bool {
        day < Calendar.current.startOfDay(for: Date()) && workouts.contains { !$0.isDone }
    }

    var body: some View {
        VStack(spacing: 2) {
            Text(day.formatted(.dateTime.day()))
                .font(.footnote.weight(isToday ? .bold : .regular))
                .foregroundStyle(isSelected ? Color.white : isToday ? Color.accentColor : Color.primary)
                .frame(width: 26, height: 26)
                .background(Circle().fill(isSelected ? Color.accentColor : .clear))

            HStack(spacing: 0) {
                ForEach(workouts.prefix(2)) { workout in
                    if workout.isDone {
                        Text("\u{2713}").foregroundStyle(.green)
                    } else {
                        Text(Sports.icon(workout.sport))
                    }
                }
                if workouts.count > 2 { Text("+").foregroundStyle(.secondary) }
            }
            .font(.caption2)
            .frame(height: 14)
        }
        .frame(maxWidth: .infinity, minHeight: 48)
        .background(
            RoundedRectangle(cornerRadius: 8, style: .continuous)
                .fill(isMissed ? Color.orange.opacity(0.15) : .clear)
        )
        .contentShape(Rectangle())
        .accessibilityElement(children: .ignore)
        .accessibilityLabel(accessibility)
        .accessibilityAddTraits(isSelected ? [.isButton, .isSelected] : .isButton)
    }

    private var accessibility: String {
        let names = workouts.map { $0.isDone ? "\($0.name), done" : $0.name }
        return ([Formats.day(day)] + (names.isEmpty ? ["nothing planned"] : names)).joined(separator: ", ")
    }
}
