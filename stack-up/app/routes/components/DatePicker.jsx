import { useState, useEffect } from "react";

// Helper to format Date object to YYYY-MM-DD
function formatDate(d) {
    const year = d.getFullYear();
    const month = String(d.getMonth() + 1).padStart(2, "0");
    const day = String(d.getDate()).padStart(2, "0");
    return `${year}-${month}-${day}`;
}

// Preset range calculations
function getPresetRange(presetKey) {
    const today = new Date();
    const end = new Date(today);
    let start = new Date(today);

    switch (presetKey) {
        case "Today":
            start = new Date(today);
            break;
        case "Yesterday":
            start.setDate(today.getDate() - 1);
            end.setDate(today.getDate() - 1);
            break;
        case "Last 7 days":
            start.setDate(today.getDate() - 6);
            break;
        case "Last 30 Days":
        case "Last 30 days":
            start.setDate(today.getDate() - 29);
            break;
        case "Last 90 Days":
        case "Last 90 days":
            start.setDate(today.getDate() - 89);
            break;
        case "This Month":
            start = new Date(today.getFullYear(), today.getMonth(), 1);
            break;
        case "Last Month":
            start = new Date(today.getFullYear(), today.getMonth() - 1, 1);
            end.setTime(new Date(today.getFullYear(), today.getMonth(), 0).getTime());
            break;
        default:
            break;
    }

    return {
        start: formatDate(start),
        end: formatDate(end),
    };
}

const PRESET_OPTIONS = [
    "Today",
    "Yesterday",
    "Last 7 days",
    "Last 30 Days",
    "Last 90 Days",
    "This Month",
    "Last Month",
    "Custom",
];

export default function DatePicker({
    onApply,
    initialPreset = "Last 30 Days",
    initialStartDate,
    initialEndDate,
}) {
    // Applied states (controls what is shown in the trigger button)
    const [appliedPreset, setAppliedPreset] = useState(initialPreset);
    const initialRange = getPresetRange(initialPreset);
    const [appliedStart, setAppliedStart] = useState(initialStartDate || initialRange.start);
    const [appliedEnd, setAppliedEnd] = useState(initialEndDate || initialRange.end);

    // Draft states inside the popover
    const [selectedPreset, setSelectedPreset] = useState(appliedPreset);
    const [startDate, setStartDate] = useState(appliedStart);
    const [endDate, setEndDate] = useState(appliedEnd);
    const [calendarView, setCalendarView] = useState(
        appliedEnd ? appliedEnd.substring(0, 7) : formatDate(new Date()).substring(0, 7)
    );

    // Synchronize if external props change
    useEffect(() => {
        if (initialStartDate && initialEndDate) {
            setAppliedStart(initialStartDate);
            setAppliedEnd(initialEndDate);
            setStartDate(initialStartDate);
            setEndDate(initialEndDate);
        }
    }, [initialStartDate, initialEndDate]);

    // Handle clicking a preset on the left side
    const handleSelectPreset = (preset) => {
        setSelectedPreset(preset);
        if (preset !== "Custom") {
            const range = getPresetRange(preset);
            setStartDate(range.start);
            setEndDate(range.end);
            setCalendarView(range.end.substring(0, 7));
        }
    };

    // Handle calendar range selection change
    const handleCalendarChange = (event) => {
        const value = event.currentTarget.value;
        if (!value) return;

        const [nextStart, rawEnd] = value.split("--");
        const nextEnd = rawEnd || nextStart;

        // Ignore events that repeat the range set by a preset.
        if (nextStart === startDate && nextEnd === endDate) {
            return;
        }

        setStartDate(nextStart);
        setEndDate(nextEnd);
        setSelectedPreset("Custom");
    };

    // Handle date field inputs
    const handleStartDateChange = (e) => {
        const val = e?.target?.value;
        if (val) {
            setStartDate(val);
            setSelectedPreset("Custom");
            if (val.length >= 7) setCalendarView(val.substring(0, 7));
        }
    };

    const handleEndDateChange = (e) => {
        const val = e?.target?.value;
        if (val) {
            setEndDate(val);
            setSelectedPreset("Custom");
            if (val.length >= 7) setCalendarView(val.substring(0, 7));
        }
    };

    // Apply button
    const handleApply = () => {
        setAppliedPreset(selectedPreset);
        setAppliedStart(startDate);
        setAppliedEnd(endDate);

        if (onApply) {
            onApply({
                preset: selectedPreset,
                startDate,
                endDate,
            });
        }
    };

    // Cancel button
    const handleCancel = () => {
        setSelectedPreset(appliedPreset);
        setStartDate(appliedStart);
        setEndDate(appliedEnd);
        if (appliedEnd) {
            setCalendarView(appliedEnd.substring(0, 7));
        }
    };

    const calendarValue = startDate && endDate ? `${startDate}--${endDate}` : startDate || "";

    const triggerLabel =
        appliedPreset !== "Custom"
            ? appliedPreset
            : appliedStart === appliedEnd
                ? appliedStart
                : `${appliedStart} → ${appliedEnd}`;

    return (
        <s-stack gap="none">
            {/* Popover trigger button */}
            <s-button
                icon="calendar"
                commandFor="date-range-popover"
                command="--toggle"
            >
                {triggerLabel}
            </s-button>

            {/* Popover Container */}
            <s-popover id="date-range-popover" inlineSize="700px">
                <s-box padding="base">
                    <s-stack gap="base">
                        {/* 2-Column Grid: Left Presets (150px), Right Inputs + Calendar */}
                        <s-grid gridTemplateColumns="150px 1fr" gap="base">
                            {/* Left Column: Preset List using s-clickable */}
                            <s-stack gap="extra-tight">
                                {PRESET_OPTIONS.map((preset) => {
                                    const isSelected = selectedPreset === preset;
                                    return (
                                        <s-clickable
                                            key={preset}
                                            onClick={(e) => {
                                                e?.stopPropagation?.();
                                                handleSelectPreset(preset);
                                            }}
                                            onPointerDown={(e) => {
                                                e?.stopPropagation?.();
                                                handleSelectPreset(preset);
                                            }}
                                            accessibilityLabel={preset}
                                            borderRadius="base"
                                        >
                                            <s-box
                                                padding="small-200"
                                                background={isSelected ? "subdued" : "transparent"}
                                                borderRadius="base"
                                            >
                                                <s-stack
                                                    direction="inline"
                                                    justifyContent="space-between"
                                                    alignItems="center"
                                                >
                                                    <s-text
                                                        type={isSelected ? "strong" : undefined}
                                                        tone={isSelected ? undefined : "subdued"}
                                                    >
                                                        {preset}
                                                    </s-text>
                                                    {/* {isSelected && <s-icon type="check" />} */}
                                                </s-stack>
                                            </s-box>
                                        </s-clickable>
                                    );
                                })}
                            </s-stack>

                            {/* Right Column: Start Date -> End Date & Calendar */}
                            <s-stack gap="base">
                                {/* Top: Start date input, arrow, end date input */}
                                <s-grid
                                    gridTemplateColumns="1fr auto 1fr"
                                    gap="small"
                                    alignItems="center"
                                >
                                    <s-date-field
                                        label="Start date"
                                        labelAccessibilityVisibility="exclusive"
                                        value={startDate}
                                        onChange={handleStartDateChange}
                                        onInput={handleStartDateChange}
                                    />

                                    <s-icon type="arrow-right" />

                                    <s-date-field
                                        label="End date"
                                        labelAccessibilityVisibility="exclusive"
                                        value={endDate}
                                        onChange={handleEndDateChange}
                                        onInput={handleEndDateChange}
                                    />
                                </s-grid>

                                {/* Middle: Calendar */}
                                <s-date-picker
                                    type="range"
                                    view={calendarView}
                                    value={calendarValue}
                                    onInput={handleCalendarChange}
                                    onChange={handleCalendarChange}
                                />
                            </s-stack>
                        </s-grid>

                        <s-divider />

                        {/* Bottom: Action Buttons */}
                        <s-stack
                            direction="inline"
                            gap="small"
                            justifyContent="end"
                            alignItems="center"
                        >
                            <s-button
                                commandFor="date-range-popover"
                                command="--hide"
                                onClick={handleCancel}
                            >
                                Cancel
                            </s-button>

                            <s-button
                                variant="primary"
                                commandFor="date-range-popover"
                                command="--hide"
                                onClick={handleApply}
                            >
                                Apply
                            </s-button>
                        </s-stack>
                    </s-stack>
                </s-box>
            </s-popover>
        </s-stack>
    );
}
