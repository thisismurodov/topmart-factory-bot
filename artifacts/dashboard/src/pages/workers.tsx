import { useState } from "react";
import { useGetWorkers, getGetWorkersQueryKey, useCreateWorker, useDeleteWorker } from "@workspace/api-client-react";
import { useQueryClient } from "@tanstack/react-query";
import { useForm } from "react-hook-form";
import { zodResolver } from "@hookform/resolvers/zod";
import * as z from "zod";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Card, CardContent } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle, DialogTrigger } from "@/components/ui/dialog";
import { Form, FormControl, FormField, FormItem, FormLabel, FormMessage } from "@/components/ui/form";
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@/components/ui/select";
import { Plus, Trash2 } from "lucide-react";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";

const formSchema = z.object({
  name: z.string().min(1, "Ism kiritilishi shart"),
  prefix: z.string().min(1, "Prefiks kiritilishi shart").max(3, "Prefiks qisqa bo'lishi kerak"),
  phone: z.string().min(1, "Telefon raqam kiritilishi shart"),
  role: z.string().min(1, "Lavozim tanlanishi shart"),
});

export default function Workers() {
  const queryClient = useQueryClient();
  const [isAddOpen, setIsAddOpen] = useState(false);

  const { data: workers, isLoading } = useGetWorkers({
    query: { queryKey: getGetWorkersQueryKey() }
  });

  const createWorker = useCreateWorker({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetWorkersQueryKey() });
        setIsAddOpen(false);
        form.reset();
      }
    }
  });

  const deleteWorker = useDeleteWorker({
    mutation: {
      onSuccess: () => {
        queryClient.invalidateQueries({ queryKey: getGetWorkersQueryKey() });
      }
    }
  });

  const form = useForm<z.infer<typeof formSchema>>({
    resolver: zodResolver(formSchema),
    defaultValues: { name: "", prefix: "", phone: "", role: "worker" },
  });

  function onSubmit(values: z.infer<typeof formSchema>) {
    createWorker.mutate({ data: values });
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-semibold tracking-tight">Zavod ishchilari</h1>
        <Dialog open={isAddOpen} onOpenChange={setIsAddOpen}>
          <DialogTrigger asChild>
            <Button data-testid="btn-add-worker">
              <Plus className="w-4 h-4 mr-2" /> Ishchi qo'shish
            </Button>
          </DialogTrigger>
          <DialogContent>
            <DialogHeader>
              <DialogTitle>Yangi ishchi ro'yxatdan o'tkazish</DialogTitle>
              <DialogDescription>
                Yangi ishchini tizimga qo'shing. U Telegram bot orqali partiyalarni kiritishi mumkin bo'ladi.
              </DialogDescription>
            </DialogHeader>
            <Form {...form}>
              <form onSubmit={form.handleSubmit(onSubmit)} className="space-y-4">
                <FormField
                  control={form.control}
                  name="name"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>To'liq ismi</FormLabel>
                      <FormControl>
                        <Input placeholder="masalan: Aziz Karimov" {...field} data-testid="input-worker-name" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <div className="grid grid-cols-2 gap-4">
                  <FormField
                    control={form.control}
                    name="prefix"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Prefiks (Bot ID)</FormLabel>
                        <FormControl>
                          <Input placeholder="masalan: AZ" {...field} className="uppercase" data-testid="input-worker-prefix" />
                        </FormControl>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                  <FormField
                    control={form.control}
                    name="role"
                    render={({ field }) => (
                      <FormItem>
                        <FormLabel>Lavozim</FormLabel>
                        <Select onValueChange={field.onChange} defaultValue={field.value}>
                          <FormControl>
                            <SelectTrigger data-testid="select-worker-role">
                              <SelectValue placeholder="Tanlang" />
                            </SelectTrigger>
                          </FormControl>
                          <SelectContent>
                            <SelectItem value="worker">Ishchi</SelectItem>
                            <SelectItem value="packer">Qadoqlovchi</SelectItem>
                            <SelectItem value="admin">Admin</SelectItem>
                          </SelectContent>
                        </Select>
                        <FormMessage />
                      </FormItem>
                    )}
                  />
                </div>
                <FormField
                  control={form.control}
                  name="phone"
                  render={({ field }) => (
                    <FormItem>
                      <FormLabel>Telegram telefon raqami</FormLabel>
                      <FormControl>
                        <Input placeholder="+998901234567" {...field} data-testid="input-worker-phone" />
                      </FormControl>
                      <FormMessage />
                    </FormItem>
                  )}
                />
                <DialogFooter className="pt-4">
                  <Button type="submit" disabled={createWorker.isPending} data-testid="btn-submit-worker">
                    {createWorker.isPending ? "Saqlanmoqda..." : "Saqlash"}
                  </Button>
                </DialogFooter>
              </form>
            </Form>
          </DialogContent>
        </Dialog>
      </div>

      <Card className="border-border">
        <CardContent className="p-0">
          <Table>
            <TableHeader className="bg-muted/50">
              <TableRow>
                <TableHead>Ism</TableHead>
                <TableHead>Prefiks</TableHead>
                <TableHead>Lavozim</TableHead>
                <TableHead>Telefon</TableHead>
                <TableHead className="text-right w-[80px]"></TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {isLoading ? (
                Array.from({ length: 3 }).map((_, i) => (
                  <TableRow key={i}>
                    <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-12" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-24" /></TableCell>
                    <TableCell><Skeleton className="h-5 w-32" /></TableCell>
                    <TableCell></TableCell>
                  </TableRow>
                ))
              ) : workers?.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={5} className="text-center py-8 text-muted-foreground">
                    Ishchilar ro'yxatga olinmagan.
                  </TableCell>
                </TableRow>
              ) : (
                workers?.map(worker => (
                  <TableRow key={worker.name} data-testid={`worker-row-${worker.name}`}>
                    <TableCell className="font-medium">{worker.name}</TableCell>
                    <TableCell>
                      <span className="inline-flex items-center px-2 py-1 rounded text-xs font-bold uppercase bg-primary/10 text-primary border border-primary/20">
                        {worker.prefix}
                      </span>
                    </TableCell>
                    <TableCell className="text-sm">
                      {worker.role === "worker" ? "Ishchi" : worker.role === "packer" ? "Qadoqlovchi" : worker.role === "admin" ? "Admin" : worker.role}
                    </TableCell>
                    <TableCell className="font-mono text-sm text-muted-foreground">{worker.phone}</TableCell>
                    <TableCell className="text-right">
                      <AlertDialog>
                        <AlertDialogTrigger asChild>
                          <Button variant="ghost" size="icon" className="h-8 w-8 text-destructive hover:text-destructive hover:bg-destructive/10" data-testid={`btn-delete-${worker.name}`}>
                            <Trash2 className="w-4 h-4" />
                          </Button>
                        </AlertDialogTrigger>
                        <AlertDialogContent>
                          <AlertDialogHeader>
                            <AlertDialogTitle>Ishchini o'chirish?</AlertDialogTitle>
                            <AlertDialogDescription>
                              {worker.name} bundan keyin bot orqali partiya kira olmaydi. Mavjud partiyalar saqlanib qoladi.
                            </AlertDialogDescription>
                          </AlertDialogHeader>
                          <AlertDialogFooter>
                            <AlertDialogCancel>Bekor qilish</AlertDialogCancel>
                            <AlertDialogAction 
                              className="bg-destructive text-destructive-foreground hover:bg-destructive/90"
                              onClick={() => deleteWorker.mutate({ name: worker.name })}
                              data-testid="btn-confirm-delete"
                            >
                              {deleteWorker.isPending ? "O'chirilmoqda..." : "O'chirish"}
                            </AlertDialogAction>
                          </AlertDialogFooter>
                        </AlertDialogContent>
                      </AlertDialog>
                    </TableCell>
                  </TableRow>
                ))
              )}
            </TableBody>
          </Table>
        </CardContent>
      </Card>
    </div>
  );
}
