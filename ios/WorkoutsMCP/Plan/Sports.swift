// The one place a workout-mcp sport name becomes Apple's or Garmin's.

import FITSwiftSDK
import HealthKit

enum Sports {
    static func fit(_ sport: String) -> Sport {
        switch sport {
        case "running": return .running
        case "cycling": return .cycling
        case "swimming": return .swimming
        case "walking": return .walking
        case "hiking": return .hiking
        case "rowing": return .rowing
        case "training": return .training
        default: return .generic
        }
    }

    static func fitSubSport(_ subSport: String?) -> SubSport {
        switch subSport {
        case "treadmill": return .treadmill
        case "street": return .street
        case "trail": return .trail
        case "track": return .track
        case "spin": return .spin
        case "indoor_cycling": return .indoorCycling
        case "road": return .road
        case "mountain": return .mountain
        case "indoor_rowing": return .indoorRowing
        case "indoor_walking": return .indoorWalking
        case "virtual_activity": return .virtualActivity
        default: return .generic
        }
    }

    static func activityType(_ sport: String) -> HKWorkoutActivityType {
        switch sport {
        case "running": return .running
        case "cycling": return .cycling
        case "swimming": return .swimming
        case "walking": return .walking
        case "hiking": return .hiking
        case "rowing": return .rowing
        case "training": return .functionalStrengthTraining
        default: return .other
        }
    }

    /// Indoors is what the sub-sport says, and outdoors is the assumption otherwise.
    static func location(_ subSport: String?) -> HKWorkoutSessionLocationType {
        let indoors: Set<String> = [
            "treadmill", "indoor_cycling", "spin", "virtual_activity", "indoor_rowing", "indoor_walking",
        ]
        return indoors.contains(subSport ?? "") ? .indoor : .outdoor
    }
}
