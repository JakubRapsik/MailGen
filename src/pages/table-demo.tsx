import { useMemo, useState } from "react";
import { Check, ReverseLeft, X } from "@untitledui/icons";
import type { SortDescriptor } from "react-aria-components";
import { PaginationPageMinimalCenter } from "@/components/application/pagination/pagination";
import { Table, TableCard } from "@/components/application/table/table";
import { Avatar } from "@/components/base/avatar/avatar";
import { BadgeWithIcon } from "@/components/base/badges/badges";
import { Button } from "@/components/base/buttons/button";

export const Table03AlternatingFills = () => {
    const [sortDescriptor, setSortDescriptor] = useState<SortDescriptor>({
        column: "invoice",
        direction: "ascending",
    });

    const sortedItems = useMemo(() => [] as any[], [sortDescriptor]);

    const getInitials = (name: string) => {
        return name
            .split(" ")
            .map((n) => n[0])
            .join("");
    };

    return (
        <TableCard.Root>
            <Table aria-label="Team members" selectionMode="multiple" sortDescriptor={sortDescriptor} onSortChange={setSortDescriptor}>
                <Table.Header className="bg-primary">
                    <Table.Head id="id" label="Invoice" isRowHeader allowsSorting />
                    <Table.Head id="date" label="Date" allowsSorting />
                    <Table.Head id="status" label="Status" allowsSorting />
                    <Table.Head id="customer" label="Customer" />
                    <Table.Head id="purchase" label="Purchase" className="md:hidden xl:table-cell" />
                    <Table.Head id="actions" />
                </Table.Header>
                <Table.Body items={sortedItems}>
                    {(item) => (
                        <Table.Row id={item.id} className="odd:bg-secondary_subtle">
                            <Table.Cell className="font-medium text-primary">#{item.id}</Table.Cell>
                            <Table.Cell className="whitespace-nowrap">{item.date}</Table.Cell>
                            <Table.Cell>
                                {item.status === "paid" ? (
                                    <BadgeWithIcon size="sm" color="success" iconLeading={Check} className="capitalize">
                                        {item.status}
                                    </BadgeWithIcon>
                                ) : item.status === "refunded" ? (
                                    <BadgeWithIcon size="sm" color="gray" iconLeading={ReverseLeft} className="capitalize">
                                        {item.status}
                                    </BadgeWithIcon>
                                ) : (
                                    <BadgeWithIcon size="sm" color="error" iconLeading={X} className="capitalize">
                                        {item.status}
                                    </BadgeWithIcon>
                                )}
                            </Table.Cell>
                            <Table.Cell>
                                <div className="flex items-center gap-3">
                                    <Avatar initials={getInitials(item.customer.name)} src={item.customer.avatarUrl} alt={item.customer.name} size="md" />
                                    <div className="whitespace-nowrap">
                                        <p className="text-sm font-medium text-primary">{item.customer.name}</p>
                                        <p className="text-sm text-tertiary">{item.customer.email}</p>
                                    </div>
                                </div>
                            </Table.Cell>
                            <Table.Cell className="whitespace-nowrap md:hidden xl:table-cell">{item.purchase}</Table.Cell>
                            <Table.Cell>
                                <div className="flex items-center justify-end gap-3">
                                    <Button size="sm" color="link-gray">
                                        Delete
                                    </Button>
                                    <Button size="sm" color="link-color">
                                        Edit
                                    </Button>
                                </div>
                            </Table.Cell>
                        </Table.Row>
                    )}
                </Table.Body>
            </Table>

            {sortedItems.length === 0 && (
                <div className="p-6 text-center text-sm text-tertiary">Žiadne položky — zatiaľ prázdne.</div>
            )}

            <PaginationPageMinimalCenter page={1} total={10} className="px-4 py-3 md:px-6 md:pt-3 md:pb-4" />
        </TableCard.Root>
    );
};
